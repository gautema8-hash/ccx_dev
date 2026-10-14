/**
 * 用户域服务（发票抬头等）
 * 页面只依赖这一层，不直接发请求
 */
const config = require('../utils/config');
const { request } = require('../utils/request');

const INVOICE_KEY = 'lbz_invoice_v1';

/** 发票抬头列表 */
function listInvoice() {
  if (config.USE_MOCK) return Promise.resolve(wx.getStorageSync(INVOICE_KEY) || []);
  return request({ url: '/user/invoice', method: 'GET' });
}

/** 新增抬头 */
function saveInvoice(payload) {
  if (config.USE_MOCK) {
    const list = wx.getStorageSync(INVOICE_KEY) || [];
    const item = Object.assign({ id: Date.now() }, payload, { isDefault: list.length === 0 });
    list.push(item);
    wx.setStorageSync(INVOICE_KEY, list);
    return Promise.resolve({ id: item.id });
  }
  return request({ url: '/user/invoice', method: 'POST', data: payload });
}

/** 删除抬头 */
function deleteInvoice(id) {
  if (config.USE_MOCK) {
    const list = (wx.getStorageSync(INVOICE_KEY) || []).filter((x) => String(x.id) !== String(id));
    wx.setStorageSync(INVOICE_KEY, list);
    return Promise.resolve({ ok: true });
  }
  return request({ url: '/user/invoice/' + id, method: 'DELETE' });
}

module.exports = { listInvoice, saveInvoice, deleteInvoice };
