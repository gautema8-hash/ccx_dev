/**
 * 订单流转规则（商家侧）
 *
 * ── 为什么放在小程序后端 ──
 * 状态机、库存回滚、券退回、退款调用这些是**领域规则**，只能有一份实现。
 * 管理系统后端通过 `POST /internal/*` 调用本模块，而不是自己再写一遍——
 * 否则会出现"小程序端改了状态机、管理端没改"的分裂，最终状态错乱或超卖。
 *
 * 本模块不依赖管理端的 ctx / rbac：权限与门店范围由管理端在调用前断言，
 * 这里只负责「能不能流转」与「流转后要回滚什么」。
 */
const db = require('../db');
const logger = require('../logger');
const auth = require('../auth');
const orderRoute = require('./order');
const payRoute = require('./pay');
const { bizError, notFound, CODES } = require('../errors');

const { ORDER_STATUS, transition } = orderRoute;

/** 合法流转：动作 → 允许的原状态 / 目标状态 / 文案 */
const FLOW = {
  accept: { from: [ORDER_STATUS.PAID], to: ORDER_STATUS.ACCEPTED, text: '商家接单' },
  cook: { from: [ORDER_STATUS.ACCEPTED], to: ORDER_STATUS.COOKING, text: '开始制作' },
  ready: { from: [ORDER_STATUS.COOKING], to: ORDER_STATUS.READY, text: '已出餐' },
  done: { from: [ORDER_STATUS.READY], to: ORDER_STATUS.DONE, text: '订单完成' },
};

/** 订单完成后失效用户缓存（积分变了） */
function invalidateUser(userId) {
  try {
    return auth.invalidateUser(userId);
  } catch (e) {
    return Promise.resolve();
  }
}

/**
 * 推进订单状态
 * @param {{orderId:string, action:string, staffId:number|string}} p
 */
async function advance(p) {
  const rule = FLOW[p.action];
  if (!rule) throw bizError(CODES.PARAM_INVALID, '未知的流转动作：' + p.action);

  const orderId = String(p.orderId || '');
  const order = await db.queryOne('SELECT * FROM mp_order WHERE id = ?', [orderId]);
  if (!order) throw notFound('订单不存在');
  if (rule.from.indexOf(order.status) === -1) {
    throw bizError(CODES.STATE_CONFLICT, `当前状态（${order.status}）不能执行「${rule.text}」`);
  }

  await db.tx(async (tx) => {
    const ok1 = await transition(tx, orderId, order.status, rule.to, 'staff:' + p.staffId, rule.text);
    if (!ok1) throw bizError(CODES.STATE_CONFLICT, '订单状态已被其他操作变更，请刷新');
    if (rule.to === ORDER_STATUS.DONE) {
      await tx.execute('UPDATE mp_order SET finish_time = ?, updated_at = ? WHERE id = ?', [Date.now(), Date.now(), orderId]);
      const gain = Math.floor(order.pay_amount / 100);
      if (gain > 0) {
        const r = await tx.execute('UPDATE mp_order SET points_granted = 1 WHERE id = ? AND points_granted = 0', [orderId]);
        if (r.affectedRows > 0) {
          await tx.execute('UPDATE mp_user SET points = points + ?, updated_at = ? WHERE id = ?', [gain, Date.now(), order.user_id]);
        }
      }
    } else {
      await tx.execute('UPDATE mp_order SET updated_at = ? WHERE id = ?', [Date.now(), orderId]);
    }
  });
  if (rule.to === ORDER_STATUS.DONE) await invalidateUser(order.user_id);
  logger.info('order advanced', { orderId, action: p.action, storeId: order.store_id, by: p.staffId });
  return { ok: true, status: rule.to };
}

/**
 * 拒单：已支付走退款；未支付/已接单直接取消并回滚库存与券
 * @param {{orderId:string, reason:string, staffId:number|string}} p
 */
async function reject(p) {
  const orderId = String(p.orderId || '');
  const reason = String(p.reason || '商家拒单').slice(0, 100);
  const order = await db.queryOne('SELECT * FROM mp_order WHERE id = ?', [orderId]);
  if (!order) throw notFound('订单不存在');
  if ([ORDER_STATUS.PAID, ORDER_STATUS.UNPAID, ORDER_STATUS.ACCEPTED].indexOf(order.status) === -1) {
    throw bizError(CODES.STATE_CONFLICT, '该状态不可拒单');
  }

  if (order.status === ORDER_STATUS.PAID) {
    const ins = await db.execute(
      "INSERT INTO mp_refund (order_id, user_id, amount, reason, status, created_at, updated_at) VALUES (?,?,?,?,'APPROVED',?,?)",
      [orderId, order.user_id, order.pay_amount, reason, Date.now(), Date.now()]
    );
    const r = await payRoute.doRefund({ id: ins.insertId, amount: order.pay_amount, reason }, order);
    await db.tx(async (tx) => {
      await tx.execute("UPDATE mp_refund SET status='REFUNDED', refund_id=?, updated_at=? WHERE id=?", [
        String(r.refund_id || ''), Date.now(), ins.insertId,
      ]);
      const ok1 = await transition(tx, orderId, ORDER_STATUS.PAID, ORDER_STATUS.CANCELED, 'staff:' + p.staffId, '拒单退款：' + reason);
      if (!ok1) throw bizError(CODES.STATE_CONFLICT, '订单状态已变更');
      await tx.execute('UPDATE mp_order SET cancel_time=?, cancel_reason=?, updated_at=? WHERE id=?', [
        Date.now(), reason, Date.now(), orderId,
      ]);
    });
    logger.info('order rejected with refund', { orderId, amount: order.pay_amount, by: p.staffId });
    return { ok: true, refunded: true, amount: order.pay_amount };
  }

  await db.tx(async (tx) => {
    const ok1 = await transition(tx, orderId, order.status, ORDER_STATUS.CANCELED, 'staff:' + p.staffId, '拒单：' + reason);
    if (!ok1) throw bizError(CODES.STATE_CONFLICT, '订单状态已变更');
    await tx.execute('UPDATE mp_order SET cancel_time=?, cancel_reason=?, updated_at=? WHERE id=?', [
      Date.now(), reason, Date.now(), orderId,
    ]);
    /* 回滚门店库存 */
    const items = await tx.query('SELECT dish_id, quantity FROM mp_order_item WHERE order_id = ?', [orderId]);
    for (const it of items) {
      await tx.execute(
        'UPDATE mp_store_dish SET stock = stock + ?, sold = GREATEST(sold - ?, 0), updated_at = ? WHERE store_id = ? AND dish_id = ?',
        [it.quantity, it.quantity, Date.now(), order.store_id, it.dish_id]
      );
    }
    /* 券退回 */
    if (order.coupon_id) {
      await tx.execute("UPDATE mp_user_coupon SET status='UNUSED', order_id='', used_at=0 WHERE order_id=? AND status='USED'", [orderId]);
      await tx.execute('UPDATE mp_coupon SET used_count = GREATEST(used_count - 1, 0) WHERE id = ?', [order.coupon_id]);
    }
  });
  logger.info('order rejected', { orderId, by: p.staffId });
  return { ok: true, refunded: false };
}

/** 退款审核通过：调支付退款 + 订单转 CANCELED */
async function approveRefund(p) {
  const refundId = Number(p.refundId);
  if (!refundId) throw bizError(CODES.PARAM_INVALID, '退款申请 id 非法');
  const row = await db.queryOne('SELECT * FROM mp_refund WHERE id = ?', [refundId]);
  if (!row) throw notFound('退款申请不存在');
  if (row.status !== 'APPLIED') throw bizError(CODES.STATE_CONFLICT, '该申请已处理');
  const order = await db.queryOne('SELECT * FROM mp_order WHERE id = ?', [row.order_id]);
  if (!order) throw notFound('订单不存在');

  const r = await payRoute.doRefund(row, order);
  await db.tx(async (tx) => {
    await tx.execute("UPDATE mp_refund SET status='REFUNDED', refund_id=?, updated_at=? WHERE id=?", [
      String(r.refund_id || ''), Date.now(), row.id,
    ]);
    const ok1 = await transition(tx, order.id, order.status, ORDER_STATUS.CANCELED, 'staff:' + p.staffId, '退款通过');
    if (!ok1) throw bizError(CODES.STATE_CONFLICT, '订单状态已变更');
    await tx.execute('UPDATE mp_order SET cancel_time=?, cancel_reason=?, updated_at=? WHERE id=?', [
      Date.now(), '退款：' + row.reason, Date.now(), order.id,
    ]);
  });
  logger.info('refund approved', { refundId, orderId: order.id, amount: row.amount, by: p.staffId });
  return { ok: true, refundId: r.refund_id };
}

/** 退款审核驳回 */
async function rejectRefund(p) {
  const refundId = Number(p.refundId);
  if (!refundId) throw bizError(CODES.PARAM_INVALID, '退款申请 id 非法');
  const row = await db.queryOne('SELECT r.*, o.store_id FROM mp_refund r LEFT JOIN mp_order o ON o.id = r.order_id WHERE r.id = ?', [refundId]);
  if (!row) throw notFound('退款申请不存在');
  const r = await db.execute("UPDATE mp_refund SET status='REJECTED', updated_at=? WHERE id=? AND status='APPLIED'", [
    Date.now(), refundId,
  ]);
  if (r.affectedRows === 0) throw bizError(CODES.STATE_CONFLICT, '该申请已处理或不存在');
  logger.info('refund rejected', { refundId, by: p.staffId });
  return { ok: true };
}

module.exports = { FLOW, advance, reject, approveRefund, rejectRefund };
