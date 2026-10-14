/**
 * 内部服务调用（管理系统后端 → 小程序后端）
 *
 * ── 为什么需要这一层 ──
 * 订单状态机、券抵扣口径、团购券核销防重、库存扣减回滚，这些**领域规则只能有一份**。
 * 如果管理端自己再实现一遍，就会出现"小程序端改了状态机、管理端没改"的分裂，
 * 最终表现为状态错乱或超卖。所以管理端的这类操作统统转发给小程序后端的 `/internal/*`。
 *
 * ── 边界 ──
 *   走 internal：订单推进 / 拒单 / 退款审核 / 团购券核销与撤销 / 定向发券 / 门店库存与上下架 / 菜单缓存失效
 *   直连 DB  ：门店、员工、菜品（品牌级）、主题、券模板、审计与登录日志（纯 CRUD，无领域规则）
 *
 * ── 失败语义 ──
 *   小程序后端不可达时抛 50200（UPSTREAM_ERROR），管理端接口明确提示"依赖服务不可用"，
 *   不做本地兜底实现——静默兜底会掩盖故障并可能产生脏数据。
 */
const config = require('./config');
const logger = require('./logger');
const { bizError, CODES } = require('./errors');

/** 带查询串的内部 GET（订单列表） */
function callGet(path) {
  const url = config.internal.baseUrl + path;
  const t0 = Date.now();
  return fetch(url, {
    method: 'GET',
    headers: { 'X-Internal-Token': config.internal.token },
    signal: AbortSignal.timeout ? AbortSignal.timeout(config.internal.timeoutMs) : undefined,
  })
    .then((r) => r.json().catch(() => ({ code: CODES.UPSTREAM_ERROR, message: '内部服务返回非 JSON' })))
    .then((j) => {
      const cost = Date.now() - t0;
      if (cost > 1000) logger.warn('internal slow', { path, cost });
      if (!j || j.code !== 0) {
        throw bizError(j && j.code ? j.code : CODES.UPSTREAM_ERROR, (j && j.message) || '内部服务调用失败');
      }
      return j.data;
    })
    .catch((e) => {
      if (e && e.code) throw e;
      logger.error('internal call failed', { path, message: e && e.message });
      throw bizError(CODES.UPSTREAM_ERROR, '依赖的小程序服务不可用，请稍后重试');
    });
}

function call(path, body) {
  const url = config.internal.baseUrl + path;
  const t0 = Date.now();
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': config.internal.token,
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout ? AbortSignal.timeout(config.internal.timeoutMs) : undefined,
  })
    .then((r) =>
      r.json().catch(() => ({ code: CODES.UPSTREAM_ERROR, message: '内部服务返回非 JSON' }))
    )
    .then((j) => {
      const cost = Date.now() - t0;
      if (cost > 1000) logger.warn('internal slow', { path, cost });
      if (!j || j.code !== 0) {
        /* 业务错误原样透传：管理端看到的提示必须和小程序端一致 */
        const err = bizError(j && j.code ? j.code : CODES.UPSTREAM_ERROR, (j && j.message) || '内部服务调用失败');
        throw err;
      }
      return j.data;
    })
    .catch((e) => {
      if (e && e.code) throw e;
      logger.error('internal call failed', { path, message: e && e.message });
      throw bizError(CODES.UPSTREAM_ERROR, '依赖的小程序服务不可用，请稍后重试');
    });
}

module.exports = {
  /** 订单列表（DTO 由小程序后端产出，展示口径只有一份） */
  listOrders: (queryString) => callGet('/internal/orders?' + String(queryString || '')),
  /** 订单推进：accept / cook / ready / done */
  advanceOrder: (orderId, action, staffId) =>
    call('/internal/orders/' + encodeURIComponent(orderId) + '/advance', { action, staffId }),
  /** 拒单（已支付自动退款） */
  rejectOrder: (orderId, reason, staffId) =>
    call('/internal/orders/' + encodeURIComponent(orderId) + '/reject', { reason, staffId }),
  /** 退款审核 */
  approveRefund: (refundId, staffId) => call('/internal/refunds/' + encodeURIComponent(refundId) + '/approve', { staffId }),
  rejectRefund: (refundId, staffId) => call('/internal/refunds/' + encodeURIComponent(refundId) + '/reject', { staffId }),
  /** 团购券核销 / 撤销 */
  verifyVoucher: (payload) => call('/internal/vouchers/verify', payload),
  refundVoucher: (voucherId, staffId) =>
    call('/internal/vouchers/' + encodeURIComponent(voucherId) + '/refund', { staffId }),
  /** 定向发券 */
  grantCoupon: (couponId, targets, operatorId) =>
    call('/internal/coupons/' + encodeURIComponent(couponId) + '/grant', Object.assign({}, targets, { operatorId })),
  /** 门店库存 / 改价批量更新 */
  updateStoreDishes: (storeId, items, staffId) =>
    call('/internal/store-dishes', { storeId, items, staffId }),
  /** 门店菜品上下架 */
  toggleStoreDish: (dishId, storeId, status, staffId) =>
    call('/internal/dishes/' + encodeURIComponent(dishId) + '/status', { storeId, status, staffId }),
  /** 失效菜单缓存（改价/改库存/上下架后调用） */
  invalidateMenuCache: (storeId) => call('/internal/menu-cache/invalidate', { storeId: storeId || '' }),
};
