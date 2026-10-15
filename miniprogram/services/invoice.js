/**
 * 发票管理服务（「我的 → 发票管理」）
 *   · 待开票订单：已支付且实付 > 0、尚未成功开票的订单
 *   · 开票历史：提交过的开票申请与状态
 * 抬头管理仍走 services/user.js（与下单开票共用同一份抬头数据）
 */
const config = require('../utils/config');
const { request } = require('../utils/request');

/** 待开票订单 */
function invoicableOrders() {
  if (config.USE_MOCK) return Promise.resolve([]);
  return request({ url: '/user/invoice/orders', method: 'GET', idempotent: true }).then((d) => d.list || []);
}

/** 开票历史（status 可选：PENDING|PROCESSING|ISSUED|REJECTED） */
function listRecords(status) {
  if (config.USE_MOCK) return Promise.resolve([]);
  return request({ url: '/user/invoice/records', method: 'GET', data: { status: status || '' }, idempotent: true }).then(
    (d) => d.list || []
  );
}

/** 提交开票申请（可传 titleId 用已保存抬头，或直接传 title/taxNo 临时抬头） */
function apply(payload) {
  if (config.USE_MOCK) return Promise.resolve({ id: Date.now(), status: 'PENDING', statusText: '待处理' });
  return request({ url: '/user/invoice/records', method: 'POST', data: payload });
}

/** 开票详情（含订单快照） */
function recordDetail(id) {
  if (config.USE_MOCK) return Promise.resolve(null);
  return request({ url: '/user/invoice/records/' + id, method: 'GET', idempotent: true });
}

module.exports = { invoicableOrders, listRecords, apply, recordDetail };
