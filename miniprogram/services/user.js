/**
 * 用户域服务：地址簿 / 发票抬头 / 账号注销
 * 页面只依赖这一层，不直接发请求
 */
const config = require('../utils/config');
const { request } = require('../utils/request');

const INVOICE_KEY = 'lbz_invoice_v1';
const ADDRESS_KEY = 'lbz_address_v1';

/* ============================ 发票抬头 ============================ */

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

/* ============================ 地址簿 ============================ */

/** 地址列表（默认地址由服务端置顶） */
function listAddress() {
  if (config.USE_MOCK) return Promise.resolve(wx.getStorageSync(ADDRESS_KEY) || []);
  return request({ url: '/addresses', method: 'GET', idempotent: true }).then((d) => d.list || []);
}

function buildAddressBody(form) {
  return {
    name: form.name,
    phone: form.phone,
    province: form.province,
    city: form.city,
    district: form.district,
    detail: form.detail,
    tag: form.tag || '',
    isDefault: !!form.isDefault,
  };
}

/** 新增地址 */
function createAddress(form) {
  if (config.USE_MOCK) {
    const list = wx.getStorageSync(ADDRESS_KEY) || [];
    const id = Date.now();
    const item = Object.assign({ id, regionText: [form.province, form.city, form.district].join(' ') }, buildAddressBody(form));
    if (item.isDefault || !list.length) {
      list.forEach((x) => (x.isDefault = false));
      item.isDefault = true;
    }
    list.unshift(item);
    wx.setStorageSync(ADDRESS_KEY, list);
    return Promise.resolve({ id });
  }
  return request({ url: '/addresses', method: 'POST', data: buildAddressBody(form) });
}

/** 编辑地址 */
function updateAddress(id, form) {
  if (config.USE_MOCK) {
    const list = wx.getStorageSync(ADDRESS_KEY) || [];
    list.forEach((x) => {
      if (String(x.id) === String(id)) Object.assign(x, buildAddressBody(form), { regionText: [form.province, form.city, form.district].join(' ') });
      else if (form.isDefault) x.isDefault = false;
    });
    wx.setStorageSync(ADDRESS_KEY, list);
    return Promise.resolve({ ok: true });
  }
  return request({ url: '/addresses/' + id, method: 'PUT', data: buildAddressBody(form) });
}

/** 删除地址（删默认后服务端会自动补位） */
function deleteAddress(id) {
  if (config.USE_MOCK) {
    let list = wx.getStorageSync(ADDRESS_KEY) || [];
    const removed = list.find((x) => String(x.id) === String(id));
    list = list.filter((x) => String(x.id) !== String(id));
    if (removed && removed.isDefault && list.length) list[0].isDefault = true;
    wx.setStorageSync(ADDRESS_KEY, list);
    return Promise.resolve({ ok: true });
  }
  return request({ url: '/addresses/' + id, method: 'DELETE' });
}

/** 设为默认地址 */
function setDefaultAddress(id) {
  if (config.USE_MOCK) {
    const list = wx.getStorageSync(ADDRESS_KEY) || [];
    list.forEach((x) => (x.isDefault = String(x.id) === String(id)));
    wx.setStorageSync(ADDRESS_KEY, list);
    return Promise.resolve({ ok: true });
  }
  return request({ url: '/addresses/' + id + '/default', method: 'POST' });
}

/* ============================ 账号注销 ============================ */

/** 注销账号（服务端会匿名化并停用，客户端随后清理本地态） */
function cancelAccount(reason) {
  if (config.USE_MOCK) return Promise.resolve({ ok: true });
  return request({ url: '/user/cancel', method: 'POST', data: { reason: reason || '' } });
}

module.exports = {
  listInvoice,
  saveInvoice,
  deleteInvoice,
  listAddress,
  createAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
  cancelAccount,
};
