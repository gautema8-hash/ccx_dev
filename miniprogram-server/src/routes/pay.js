/**
 * 支付域
 *
 * 设计要点：
 *   · prepay 与「支付结果落库」彻底分离：prepay 只负责下单拿 prepay_id，
 *     真正改订单状态的只有 settlePaid()，而它被「微信回调」和「Mock 支付」共用
 *     —— 两种模式下结算逻辑完全一致，不会出现「mock 能过、真实环境挂」
 *   · 回调处理：先验签 → 再解密 → 幂等判断 → 金额比对 → 条件更新
 *   · 回调用原始报文验签（ctx.rawBody），重新序列化必然验签失败
 *   · 回调永远返回 200 + {code:'SUCCESS'}，避免微信无限重推；处理失败记日志并靠「查单对账」补偿
 */
const db = require('../db');
const config = require('../config');
const logger = require('../logger');
const wxpay = require('../wechat');
const orderRoute = require('./order');
const { bizError, notFound, unavailable, CODES } = require('../errors');

const { ORDER_STATUS, settlePaid, getOrderDetail } = orderRoute;

/* ============================================================ 下单（换 prepay_id） */
async function prepay(ctx) {
  const user = ctx.user;
  const orderId = ctx.params.id;

  const order = await db.queryOne('SELECT * FROM mp_order WHERE id = ? AND user_id = ?', [orderId, user.id]);
  if (!order) throw notFound('订单不存在');
  if (order.status === ORDER_STATUS.PAID) {
    return ctx.ok({ alreadyPaid: true, orderId });
  }
  if (order.status !== ORDER_STATUS.UNPAID) {
    throw bizError(CODES.STATE_CONFLICT, '订单当前状态不可支付');
  }
  /* 超时未支付：先真正关单（回滚库存与券），再提示重新下单 */
  if (orderRoute.isPayExpired(order)) {
    await orderRoute.closeUnpaidOrder(order.id, 'system', '超时未支付自动关闭');
    throw bizError(CODES.STATE_CONFLICT, '订单已超时关闭，请重新下单');
  }

  const outTradeNo = order.order_no;
  const now = Date.now();
  /* 预支付记录：uk_out_trade_no 保证并发/重试只会有一条 */
  await db.execute(
    `INSERT INTO mp_pay_record (order_id, out_trade_no, amount, status, channel, created_at, updated_at)
     VALUES (?,?,?,'CREATED','wechat',?,?)
     ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)`,
    [order.id, outTradeNo, order.pay_amount, now, now]
  );

  if (config.pay.mode !== 'real') {
    return ctx.ok({
      mock: true,
      orderId: order.id,
      outTradeNo,
      amount: order.pay_amount,
      amountText: (order.pay_amount / 100).toFixed(2),
      tip: '当前 PAY_MODE=mock，客户端确认后调 /orders/:id/mock-pay 完成结算',
    });
  }

  const prepayId = await wxpay.jsapiPrepay({
    outTradeNo,
    description: '老北京麻辣串串香-' + (order.table_no ? order.table_no + '桌' : '点餐'),
    amount: order.pay_amount,
    openid: user.openid,
    attach: order.id,
  });
  const params = wxpay.buildPayParams(prepayId);
  logger.info('prepay ok', { requestId: ctx.requestId, orderNo: outTradeNo, amount: order.pay_amount });
  return ctx.ok(Object.assign({ mock: false, orderId: order.id, outTradeNo }, params));
}

/* ============================================================ Mock 支付（仅 PAY_MODE=mock） */
async function mockPay(ctx) {
  if (config.pay.mode === 'real') throw bizError(CODES.FORBIDDEN, '当前为真实支付模式，不接受模拟支付');
  const user = ctx.user;
  const orderId = ctx.params.id;
  const order = await db.queryOne('SELECT * FROM mp_order WHERE id = ? AND user_id = ?', [orderId, user.id]);
  if (!order) throw notFound('订单不存在');

  const changed = await settlePaid(orderId, 'MOCK_' + order.order_no, order.pay_amount, '模拟支付成功');
  logger.info('mock pay settled', { requestId: ctx.requestId, orderId, changed });
  const dto = await getOrderDetail(orderId, user.id);
  return ctx.ok(dto);
}

/* ============================================================ 支付结果回调 */
async function notify(ctx) {
  const raw = ctx.rawBody || '';

  if (config.pay.mode === 'real') {
    const verified = await wxpay.verifyNotify(ctx.headers, raw).catch((e) => {
      logger.error('notify verify threw', { message: e.message });
      return false;
    });
    if (!verified) {
      logger.warn('notify signature invalid', { requestId: ctx.requestId, ip: ctx.ip });
      // 返回 401，微信会重推；绝不解密未验签的报文
      return ctx.send(401, { code: 'FAIL', message: '签名验证失败' });
    }
  }

  let payload;
  try {
    payload = ctx.body && ctx.body.resource ? wxpay.decryptNotifyResource(ctx.body.resource) : ctx.body;
  } catch (e) {
    logger.error('notify decrypt failed', { requestId: ctx.requestId, message: e.message });
    return ctx.send(400, { code: 'FAIL', message: '解密失败' });
  }

  const outTradeNo = payload.out_trade_no;
  const txnId = payload.transaction_id;
  const tradeState = payload.trade_state;

  if (!outTradeNo) {
    return ctx.send(400, { code: 'FAIL', message: '缺少 out_trade_no' });
  }
  if (tradeState && tradeState !== 'SUCCESS') {
    logger.warn('notify non-success state', { outTradeNo, tradeState });
    db.execute("UPDATE mp_pay_record SET status='FAIL', updated_at=? WHERE out_trade_no=? AND status<>'SUCCESS'", [
      Date.now(), outTradeNo,
    ]).catch(() => {});
    return ctx.send(200, { code: 'SUCCESS', message: '成功' });
  }

  const order = await db.queryOne('SELECT * FROM mp_order WHERE order_no = ?', [outTradeNo]);
  if (!order) {
    logger.warn('notify order not found', { outTradeNo });
    /* 返回 SUCCESS，避免微信对无效单反复重推 */
    return ctx.send(200, { code: 'SUCCESS', message: '成功' });
  }

  try {
    const changed = await settlePaid(order.id, txnId, payload.amount && payload.amount.total, '微信支付成功');
    await db.execute('UPDATE mp_pay_record SET raw = ? WHERE out_trade_no = ?', [JSON.stringify(payload).slice(0, 60000), outTradeNo]);
    logger.info('notify settled', { outTradeNo, txnId, changed });
  } catch (e) {
    /* 金额不一致等异常：记录并返回失败让微信重推，人工介入 */
    logger.error('notify settle failed', { outTradeNo, message: e.message, code: e.code });
    return ctx.send(500, { code: 'FAIL', message: e.message });
  }
  return ctx.send(200, { code: 'SUCCESS', message: '成功' });
}

/* ============================================================ 主动查单（对账兜底） */
async function queryPay(ctx) {
  const user = ctx.user;
  const orderId = ctx.params.id;
  const order = await db.queryOne('SELECT * FROM mp_order WHERE id = ? AND user_id = ?', [orderId, user.id]);
  if (!order) throw notFound('订单不存在');

  if (order.status !== ORDER_STATUS.UNPAID) {
    return ctx.ok({ status: order.status, paid: true });
  }
  if (config.pay.mode !== 'real') {
    return ctx.ok({ status: order.status, paid: false, mock: true });
  }
  const r = await wxpay.queryOrder(order.order_no);
  if (r && r.trade_state === 'SUCCESS') {
    await settlePaid(order.id, r.transaction_id, r.amount && r.amount.total, '主动查单补偿');
    return ctx.ok({ status: ORDER_STATUS.PAID, paid: true, compensated: true });
  }
  return ctx.ok({ status: order.status, paid: false, tradeState: r ? r.trade_state : 'UNKNOWN' });
}

/* ============================================================ 退款（门店审核通过后调用） */
async function doRefund(refundRow, order) {
  if (config.pay.mode !== 'real') {
    return { refund_id: 'MOCK_REFUND_' + refundRow.id, mock: true };
  }
  return wxpay.refund({
    outTradeNo: order.order_no,
    outRefundNo: 'RF' + refundRow.id + Date.now().toString(36),
    total: order.pay_amount,
    refund: refundRow.amount,
    reason: refundRow.reason,
  });
}

module.exports = { prepay, mockPay, notify, queryPay, doRefund };
