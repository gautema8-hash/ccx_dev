/**
 * 发票管理（「我的 → 发票管理」）
 *
 * 业务规则（与「开票须知」协议一致，改这里必须同步改协议文案）：
 *   · 可开票订单：已完成/已支付且实付金额 > 0 的订单
 *   · 一笔订单只对应一张发票（mp_invoice_request 上 uk_order 兜底，驳回后可复用同行重提）
 *   · 申请时快照抬头信息 —— 之后用户改抬头不影响已提交的申请（发票信息不能被追溯篡改）
 */
const db = require('../db');
const redis = require('../redis');
const { bizError, notFound, tooMany, CODES } = require('../errors');

const STATUS_TEXT = { PENDING: '待处理', PROCESSING: '开票中', ISSUED: '已开具', REJECTED: '已驳回' };

/* 可开票的订单状态：已支付之后（含已完成），未支付/已取消不可开票 */
const INVOICABLE_STATUS = ['PAID', 'ACCEPTED', 'COOKING', 'READY', 'DONE'];
/* 已经占用「开票名额」的申请状态：驳回的可以重新申请 */
const BLOCKING_STATUS = ['PENDING', 'PROCESSING', 'ISSUED'];

function recordDto(r) {
  return {
    id: Number(r.id),
    orderId: r.order_id,
    orderNo: r.order_no,
    storeId: r.store_id,
    amount: Number(r.amount),
    titleType: r.title_type,
    title: r.title,
    taxNo: r.tax_no,
    email: r.email,
    status: r.status,
    statusText: STATUS_TEXT[r.status] || r.status,
    invoiceNo: r.invoice_no || '',
    invoiceUrl: r.invoice_url || '',
    remark: r.remark || '',
    appliedAt: Number(r.applied_at),
    issuedAt: Number(r.issued_at),
  };
}

/** 待开票订单：可开票且尚未成功申请（或曾被驳回）的订单 */
async function invoicableOrders(ctx) {
  const size = Math.min(Math.max(Number(ctx.query.size || 20), 1), 50);
  const rows = await db.query(
    `SELECT o.id, o.order_no, o.store_id, o.dining_type, o.item_count,
            o.pay_amount, o.status, o.pay_time, o.finish_time, o.created_at,
            s.name AS store_name, r.id AS req_id, r.status AS req_status
     FROM mp_order o
     LEFT JOIN mp_store s ON s.id = o.store_id
     LEFT JOIN mp_invoice_request r ON r.order_id = o.id
     WHERE o.user_id = ? AND o.status IN (${INVOICABLE_STATUS.map(() => '?').join(',')}) AND o.pay_amount > 0
       AND (r.id IS NULL OR r.status = 'REJECTED')
     ORDER BY COALESCE(o.finish_time, o.pay_time, o.created_at) DESC
     LIMIT ?`,
    [ctx.user.id].concat(INVOICABLE_STATUS, [size])
  );
  return ctx.ok({
    list: rows.map((r) => ({
      orderId: r.id,
      orderNo: r.order_no,
      storeId: r.store_id,
      storeName: r.store_name || '',
      diningType: r.dining_type,
      itemCount: Number(r.item_count),
      amount: Number(r.pay_amount),
      status: r.status,
      time: Number(r.finish_time || r.pay_time || r.created_at),
      /** 被驳回过的订单给出提示，避免用户重复踩坑 */
      rejected: r.req_status === 'REJECTED',
    })),
    total: rows.length,
  });
}

/** 开票历史 */
async function listRecords(ctx) {
  const status = String(ctx.query.status || '').trim();
  const params = [ctx.user.id];
  let where = 'user_id = ?';
  if (STATUS_TEXT[status]) {
    where += ' AND status = ?';
    params.push(status);
  }
  const rows = await db.query(
    `SELECT * FROM mp_invoice_request WHERE ${where} ORDER BY applied_at DESC LIMIT 50`,
    params
  );
  return ctx.ok({ list: rows.map(recordDto), total: rows.length });
}

/** 提交开票申请 */
async function apply(ctx) {
  const rl = await redis.rateLimit.hit('invoice:' + ctx.user.id, 10, 60);
  if (!rl.allowed) throw tooMany('提交过于频繁，请稍后再试');

  const b = ctx.body || {};
  const orderId = String(b.orderId || '').slice(0, 40);
  const email = String(b.email || '').trim().slice(0, 128);
  if (!orderId) throw bizError(CODES.PARAM_INVALID, '请选择要开票的订单');
  if (!/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(email)) throw bizError(CODES.PARAM_INVALID, '接收发票的邮箱格式不正确');

  const order = await db.queryOne(
    'SELECT id, order_no, user_id, store_id, status, pay_amount FROM mp_order WHERE id = ? AND user_id = ?',
    [orderId, ctx.user.id]
  );
  if (!order) throw notFound('订单不存在');
  if (INVOICABLE_STATUS.indexOf(order.status) === -1) throw bizError(CODES.STATE_CONFLICT, '该订单当前状态不可开票');
  if (Number(order.pay_amount) <= 0) throw bizError(CODES.STATE_CONFLICT, '该订单实付金额为 0，无需开票');

  /* 抬头：优先用 titleId（用户已保存的抬头），否则用请求体里的临时抬头 */
  let titleType = 'personal';
  let title = '';
  let taxNo = '';
  let titleId = 0;
  if (b.titleId) {
    const t = await db.queryOne('SELECT * FROM mp_invoice WHERE id = ? AND user_id = ?', [Number(b.titleId), ctx.user.id]);
    if (!t) throw notFound('发票抬头不存在，请重新选择');
    titleId = Number(t.id);
    titleType = t.title_type;
    title = t.title;
    taxNo = t.tax_no;
  } else {
    title = String(b.title || '').trim().slice(0, 128);
    taxNo = String(b.taxNo || '').trim().slice(0, 64);
    titleType = b.titleType === 'company' ? 'company' : 'personal';
    if (!title) throw bizError(CODES.PARAM_INVALID, '请填写发票抬头');
    if (titleType === 'company' && !/^[0-9A-Z]{15,20}$/.test(taxNo)) {
      throw bizError(CODES.PARAM_INVALID, '纳税人识别号格式不正确（15-20 位数字/大写字母）');
    }
  }

  const exist = await db.queryOne('SELECT * FROM mp_invoice_request WHERE order_id = ?', [orderId]);
  if (exist && BLOCKING_STATUS.indexOf(exist.status) > -1) {
    throw bizError(CODES.STATE_CONFLICT, '该订单已提交过开票申请，请在开票历史中查看');
  }

  const now = Date.now();
  if (exist) {
    /* 被驳回后重提：复用原行，保留历史时间线（remark 里追加驳回原因说明） */
    await db.execute(
      `UPDATE mp_invoice_request
       SET title_id=?, title_type=?, title=?, tax_no=?, email=?, amount=?, status='PENDING', invoice_no='', applied_at=?, updated_at=?
       WHERE id = ? AND user_id = ?`,
      [titleId, titleType, title, taxNo, email, Number(order.pay_amount), now, now, exist.id, ctx.user.id]
    );
    return ctx.ok({ id: Number(exist.id), status: 'PENDING', statusText: STATUS_TEXT.PENDING, resubmit: true });
  }

  const r = await db.execute(
    `INSERT INTO mp_invoice_request
     (title_id, user_id, order_id, order_no, store_id, amount, title_type, title, tax_no, email,
      status, invoice_no, invoice_url, remark, applied_at, issued_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'PENDING','','','',?,0,?)`,
    [titleId, ctx.user.id, order.id, order.order_no, order.store_id, Number(order.pay_amount), titleType, title, taxNo, email, now, now]
  );
  return ctx.ok({ id: r.insertId, status: 'PENDING', statusText: STATUS_TEXT.PENDING, resubmit: false });
}

/** 开票详情（含订单快照，便于用户核对） */
async function recordDetail(ctx) {
  const id = Number(ctx.params.id);
  const r = await db.queryOne('SELECT * FROM mp_invoice_request WHERE id = ? AND user_id = ?', [id, ctx.user.id]);
  if (!r) throw notFound('开票记录不存在');

  const order = await db.queryOne(
    `SELECT o.id, o.order_no, o.status, o.dining_type, o.table_no, o.pickup_no, o.pay_amount, o.item_count,
            o.pay_time, o.finish_time, o.created_at, s.name AS store_name, s.address AS store_address, s.phone AS store_phone
     FROM mp_order o LEFT JOIN mp_store s ON s.id = o.store_id WHERE o.id = ?`,
    [r.order_id]
  );
  const items = await db.query(
    'SELECT dish_name, spicy_name, quantity, amount FROM mp_order_item WHERE order_id = ? LIMIT 50',
    [r.order_id]
  );

  return ctx.ok(Object.assign(recordDto(r), {
    order: order
      ? {
          id: order.id,
          orderNo: order.order_no,
          storeName: order.store_name || '',
          storeAddress: order.store_address || '',
          storePhone: order.store_phone || '',
          diningType: order.dining_type,
          tableNo: order.table_no,
          pickupNo: order.pickup_no,
          amount: Number(order.pay_amount),
          itemCount: Number(order.item_count),
          status: order.status,
          payTime: Number(order.pay_time),
          finishTime: Number(order.finish_time),
          items: items.map((i) => ({
            name: i.dish_name,
            spicy: i.spicy_name || '',
            quantity: Number(i.quantity),
            amount: Number(i.amount),
          })),
        }
      : null,
  }));
}

module.exports = { invoicableOrders, listRecords, apply, recordDetail, STATUS_TEXT, INVOICABLE_STATUS };
