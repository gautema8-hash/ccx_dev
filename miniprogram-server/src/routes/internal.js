/**
 * 内部服务接口（仅管理系统后端可调用）
 *
 * ── 为什么单独开一组 /internal ──
 * 订单状态机、券抵扣、团购券防重核销、库存扣减回滚这些领域规则**只有本服务一份实现**。
 * 管理端需要推进订单、审核退款、核销券、改库存，但不能复制这些规则
 * （复制 = 状态机分裂 = 迟早出状态错乱或超卖），所以由本服务以内部接口暴露。
 *
 * ── 鉴权 ──
 *   · 请求头 X-Internal-Token 必须等于配置的 INTERNAL_TOKEN
 *   · 未配置 INTERNAL_TOKEN 时**拒绝所有调用**（避免默认空串导致"谁都能调"）
 *   · 建议仅监听内网 / 由网关限制来源 IP
 *
 * ── 与公开接口的区别 ──
 *   不做用户鉴权（无 ctx.user），操作者身份由 body.staffId 传入并写审计/状态日志。
 */
const db = require('../db');
const logger = require('../logger');
const orderRoute = require('./order');
const payRoute = require('./pay');
const menuRoute = require('./menu');
const couponService = require('../couponService');
const voucherService = require('../voucherService');
const { bizError, notFound, CODES } = require('../errors');

/** 合法的状态推进动作 */
const ACTIONS = { accept: 'accept', cook: 'cook', ready: 'ready', done: 'done' };

/* ============================================================ 订单查询 */
/**
 * 管理端的订单列表/详情也走这里，而不是让管理端自己拼 SQL 再复制一份 DTO ——
 * 展示口径（字段命名、金额单位、时间格式）必须与小程序端一致，
 * 否则会出现"小程序显示 ¥20、后台显示 2000"这类单位分歧。
 * 门店范围由管理端算好传进来（storeIds），本接口不再重复鉴权。
 */
async function listOrders(ctx) {
  const q = ctx.query || {};
  const params = [];
  let where = 'WHERE 1=1';
  const storeIds = String(q.storeIds || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (storeIds.length) {
    where += ` AND o.store_id IN (${storeIds.map(() => '?').join(',')})`;
    params.push.apply(params, storeIds);
  } else if (q.allStores !== '1') {
    /* 没传门店且未声明全店 → 返回空，兜底方向是「查不到」 */
    return ctx.ok({ list: [], total: 0, page: 1, size: 0 });
  }
  if (q.brandId) {
    where += ' AND o.brand_id = ?';
    params.push(String(q.brandId));
  }
  if (q.status && q.status !== 'all') {
    where += ' AND o.status = ?';
    params.push(String(q.status));
  }
  if (q.from) {
    where += ' AND o.created_at >= ?';
    params.push(Number(q.from));
  }
  if (q.to) {
    where += ' AND o.created_at < ?';
    params.push(Number(q.to));
  }
  if (q.keyword) {
    where += ' AND (o.order_no LIKE ? OR o.table_no LIKE ? OR o.pickup_no LIKE ?)';
    const kw = '%' + String(q.keyword).slice(0, 32) + '%';
    params.push(kw, kw, kw);
  }

  const page = Math.min(10000, Math.max(1, Number(q.page) || 1));
  const size = Math.min(100, Math.max(1, Number(q.size) || 30));
  const totalRow = await db.queryOne(`SELECT COUNT(*) AS c FROM mp_order o ${where}`, params);
  const rows = await db.query(
    `SELECT o.*, s.name AS shop_name FROM mp_order o LEFT JOIN mp_store s ON s.id = o.store_id
     ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
    params.concat([size, (page - 1) * size])
  );
  const list = await attachItems(rows);
  return ctx.ok({ list, total: Number(totalRow.c), page, size });
}

async function getOrder(ctx) {
  const row = await db.queryOne(
    'SELECT o.*, s.name AS shop_name FROM mp_order o LEFT JOIN mp_store s ON s.id = o.store_id WHERE o.id = ?',
    [String(ctx.params.id || '')]
  );
  if (!row) throw notFound('订单不存在');
  const list = await attachItems([row]);
  return ctx.ok(list[0]);
}

/** 批量装配明细（避免 N+1） */
async function attachItems(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const items = await db.query(`SELECT * FROM mp_order_item WHERE order_id IN (${ph}) ORDER BY id ASC`, ids);
  const grouped = new Map();
  items.forEach((i) => {
    if (!grouped.has(i.order_id)) grouped.set(i.order_id, []);
    grouped.get(i.order_id).push(i);
  });
  return rows.map((r) => {
    const dto = orderRoute.toOrderDTO(r, grouped.get(r.id) || [], []);
    dto.urgeCount = r.urge_count;
    dto.rated = !!r.rated;
    return dto;
  });
}

/* ============================================================ 订单 */
async function advanceOrder(ctx) {
  const b = ctx.body || {};
  const action = String(b.action || '');
  if (!ACTIONS[action]) throw bizError(CODES.PARAM_INVALID, '未知的流转动作：' + action);

  const orderId = String(ctx.params.id || '');
  const order = await db.queryOne('SELECT * FROM mp_order WHERE id = ?', [orderId]);
  if (!order) throw notFound('订单不存在');

  /* 复用管理端同一份流转规则（含跳步校验与完成发积分） */
  const flow = require('./flow');
  const r = await flow.advance({ orderId, action, staffId: b.staffId });
  return ctx.ok(r);
}

async function rejectOrder(ctx) {
  const b = ctx.body || {};
  const orderId = String(ctx.params.id || '');
  const flow = require('./flow');
  const r = await flow.reject({ orderId, reason: String(b.reason || '商家拒单').slice(0, 100), staffId: b.staffId });
  return ctx.ok(r);
}

/* ============================================================ 退款 */
async function approveRefund(ctx) {
  const id = Number(ctx.params.id);
  const flow = require('./flow');
  return ctx.ok(await flow.approveRefund({ refundId: id, staffId: (ctx.body || {}).staffId }));
}

async function rejectRefund(ctx) {
  const id = Number(ctx.params.id);
  const flow = require('./flow');
  return ctx.ok(await flow.rejectRefund({ refundId: id, staffId: (ctx.body || {}).staffId }));
}

/* ============================================================ 团购券 */
/** 店员代客核销：与小程序端自助核销共用 voucherService，防重规则完全一致 */
async function verifyVoucher(ctx) {
  const b = ctx.body || {};
  const storeId = String(b.storeId || '').slice(0, 32);
  if (!storeId) throw bizError(CODES.PARAM_INVALID, '请选择核销门店');
  const store = await db.queryOne('SELECT * FROM mp_store WHERE id = ?', [storeId]);
  if (!store) throw notFound('门店不存在');

  const result = await voucherService.verifyVoucher({
    code: b.code,
    storeId,
    channel: 'STAFF',
    staffId: Number(b.staffId) || 0,
    platform: String(b.platform || 'MEITUAN').slice(0, 16),
  });
  logger.info('voucher verified via internal', {
    storeId,
    code: String(result.code).slice(0, 4) + '****',
    staffId: b.staffId || 0,
  });
  return ctx.ok(result);
}

async function refundVoucher(ctx) {
  const id = Number(ctx.params.id);
  if (!id) throw bizError(CODES.PARAM_INVALID, '核销记录 id 非法');
  return ctx.ok(await voucherService.refundVoucher(id, Number((ctx.body || {}).staffId) || 0));
}

/* ============================================================ 优惠券 */
/** 定向发放：复用小程序端 receive()，防超发与限领规则完全一致 */
async function grantCoupon(ctx) {
  const b = ctx.body || {};
  const couponId = String(ctx.params.id || '');
  if (!couponId) throw bizError(CODES.PARAM_INVALID, '请选择优惠券');

  const userIds = [];
  if (Array.isArray(b.userIds)) userIds.push.apply(userIds, b.userIds.map((x) => Number(x)).filter((n) => n > 0));
  if (Array.isArray(b.phones) && b.phones.length) {
    const ph = b.phones.map(() => '?').join(',');
    const rows = await db.query(`SELECT id FROM mp_user WHERE phone IN (${ph})`, b.phones.map((p) => String(p).slice(0, 32)));
    rows.forEach((r) => userIds.push(Number(r.id)));
  }
  if (Array.isArray(b.openids) && b.openids.length) {
    const ph = b.openids.map(() => '?').join(',');
    const rows = await db.query(`SELECT id FROM mp_user WHERE openid IN (${ph})`, b.openids.map((p) => String(p).slice(0, 64)));
    rows.forEach((r) => userIds.push(Number(r.id)));
  }
  const uniq = Array.from(new Set(userIds)).slice(0, 500);
  if (!uniq.length) throw bizError(CODES.PARAM_INVALID, '未匹配到任何用户（支持用户 id / 手机号 / openid）');

  const results = await couponService.grantToUsers(uniq, couponId, Number(b.operatorId) || 0);
  const okCount = results.filter((r) => r.ok).length;
  logger.info('coupon granted via internal', { couponId, total: uniq.length, ok: okCount });
  return ctx.ok({ total: uniq.length, success: okCount, results });
}

/* ============================================================ 门店菜品 */
async function updateStoreDishes(ctx) {
  const b = ctx.body || {};
  const storeId = String(b.storeId || '');
  if (!storeId) throw bizError(CODES.PARAM_INVALID, '请指定门店');
  const items = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
  if (!items.length) throw bizError(CODES.PARAM_INVALID, '没有需要更新的菜品');

  let updated = 0;
  await db.tx(async (tx) => {
    for (const it of items) {
      const dishId = String(it.dishId || '').slice(0, 32);
      if (!dishId) continue;
      const fields = [];
      const params = [];
      if (it.stock !== undefined) {
        fields.push('stock = ?');
        params.push(Math.max(0, Math.trunc(Number(it.stock) || 0)));
      }
      if (it.status !== undefined) {
        fields.push('status = ?');
        params.push(it.status ? 1 : 0);
      }
      if (it.priceOverride !== undefined) {
        fields.push('price_override = ?');
        params.push(Math.max(0, Math.trunc(Number(it.priceOverride) || 0)));
      }
      if (!fields.length) continue;
      fields.push('updated_at = ?');
      params.push(Date.now());
      params.push(storeId, dishId);
      const r = await tx.execute(
        `UPDATE mp_store_dish SET ${fields.join(', ')} WHERE store_id = ? AND dish_id = ?`,
        params
      );
      if (r.affectedRows > 0) updated++;
    }
  });
  await menuRoute.refreshMenuCache(storeId);
  return ctx.ok({ ok: true, updated });
}

async function toggleStoreDish(ctx) {
  const b = ctx.body || {};
  const dishId = String(ctx.params.id || '');
  const storeId = String(b.storeId || '');
  if (!storeId) throw bizError(CODES.PARAM_INVALID, '请指定门店');
  const r = await db.execute('UPDATE mp_store_dish SET status = ?, updated_at = ? WHERE store_id = ? AND dish_id = ?', [
    b.status ? 1 : 0, Date.now(), storeId, dishId,
  ]);
  if (r.affectedRows === 0) throw notFound('该门店未配置此菜品，请先同步菜单');
  await menuRoute.refreshMenuCache(storeId);
  return ctx.ok({ ok: true });
}

/* ============================================================ 缓存 */
async function invalidateMenuCache(ctx) {
  const storeId = String((ctx.body || {}).storeId || '');
  await menuRoute.refreshMenuCache(storeId);
  return ctx.ok({ ok: true });
}

module.exports = {
  listOrders,
  getOrder,
  advanceOrder,
  rejectOrder,
  approveRefund,
  rejectRefund,
  verifyVoucher,
  refundVoucher,
  grantCoupon,
  updateStoreDishes,
  toggleStoreDish,
  invalidateMenuCache,
  payRoute,
};
