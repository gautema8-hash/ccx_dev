const chain = require('../../services/chain');
const { toast, fen2yuan } = require('../../utils/util');
const { toastError } = require('../../utils/request');

Page({
  data: {
    themeStyle: '',
    store: null,
    storeOpen: true,
    code: '',
    submitting: false,
    canSubmit: false,
    result: null,
    records: [],
  },

  onLoad() {
    /* 默认带出当前门店；没选过就去选 */
    this.syncStore();
    this.loadRecords();
  },

  onShow() {
    chain.applyTheme(this);
    this.syncStore();
  },

  syncStore() {
    const s = chain.currentStore();
    if (!s) {
      /* 没选门店：自动去选一家（带上返回来源，选完回本页） */
      wx.navigateTo({ url: '/pages/store-list/store-list?from=voucher' });
      return;
    }
    const open = this.checkOpen(s.openTime);
    this.setData({ store: s, storeOpen: open });
    this.refreshSubmit();
  },

  /** 营业时间判断（与后端同一套规则，跨天营业也算营业中） */
  checkOpen(openTime) {
    const m = String(openTime || '').match(/(\d{1,2}):(\d{2})\s*[-~至]\s*(?:次日)?\s*(\d{1,2}):(\d{2})/);
    if (!m) return true;
    const d = new Date();
    const cur = d.getHours() * 60 + d.getMinutes();
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    if (start === end) return true;
    return end > start ? cur >= start && cur <= end : cur >= start || cur <= end;
  },

  loadRecords() {
    chain
      .myVouchers()
      .then((list) => this.setData({ records: list || [] }))
      .catch(() => {});
  },

  pickStore() {
    wx.navigateTo({ url: '/pages/store-list/store-list?from=voucher' });
  },

  onCode(e) {
    const code = String(e.detail.value || '').toUpperCase().replace(/[\s-]/g, '');
    this.setData({ code: code, result: null });
    this.refreshSubmit();
  },

  clearCode() {
    this.setData({ code: '', result: null });
    this.refreshSubmit();
  },

  refreshSubmit() {
    this.setData({ canSubmit: !!(this.data.code && this.data.store && this.data.storeOpen && !this.data.submitting) });
  },

  onSubmit() {
    if (this.data.submitting) return;
    if (!this.data.store) return toast('请先选择核销门店');
    if (!this.data.storeOpen) return toast('门店当前未营业');
    if (!this.data.code) return toast('请输入券码');

    this.setData({ submitting: true, canSubmit: false, result: null });
    wx.showLoading({ title: '核销中', mask: true });

    chain
      .verifyVoucher(this.data.code, this.data.store.id)
      .then((r) => {
        wx.hideLoading();
        this.setData({
          submitting: false,
          code: '',
          result: {
            ok: true,
            productName: r.productName,
            faceValueText: fen2yuan(r.faceValue),
            quantity: r.quantity,
            storeName: r.storeName,
            verifiedAtText: r.verifiedAtText,
          },
        });
        wx.vibrateShort && wx.vibrateShort({ type: 'medium', fail: () => {} });
        this.loadRecords();
      })
      .catch((e) => {
        wx.hideLoading();
        this.setData({
          submitting: false,
          result: { ok: false, message: (e && e.message) || '核销失败' },
        });
        this.refreshSubmit();
      });
  },

  onShareAppMessage() {
    return { title: '老北京麻辣串串香 · 团购券核销', path: '/pages/voucher/voucher' };
  },
});
