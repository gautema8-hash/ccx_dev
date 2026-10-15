/**
 * 提交开票申请
 * 入参 orderId（从「发票管理 → 待开票订单」进入）
 * 抬头来源两条路：选已保存抬头（titleId）或去抬头管理新增，服务端会在申请时快照抬头信息。
 */
const chain = require('../../../services/chain');
const userService = require('../../../services/user');
const orderService = require('../../../services/order');
const invoiceApi = require('../../../services/invoice');
const { toast } = require('../../../utils/util');
const { toastError } = require('../../../utils/request');

const EMAIL_RE = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;

Page({
  data: {
    themeStyle: '',
    loading: true,
    orderId: '',
    order: null,
    rejected: false,
    titles: [],
    titleId: '',
    email: '',
    agree: false,
    submitting: false,
  },

  onLoad(query) {
    this.setData({ orderId: (query && query.orderId) || '' });
  },

  onShow() {
    chain.applyTheme(this);
    this.fetch();
  },

  fetch() {
    const orderId = this.data.orderId;
    if (!orderId) {
      this.setData({ loading: false });
      return Promise.resolve();
    }
    this.setData({ loading: true });
    return Promise.all([
      orderService.getOrder(orderId).catch(() => null),
      userService.listInvoice().catch(() => []),
      invoiceApi.listRecords().catch(() => []),
    ])
      .then(([order, titles, records]) => {
        const list = titles || [];
        /* 保留用户已选中的抬头；首次进入默认选默认抬头，其次第一条 */
        let titleId = this.data.titleId;
        if (!list.some((t) => String(t.id) === String(titleId))) {
          const def = list.filter((t) => t.isDefault)[0] || list[0];
          titleId = def ? String(def.id) : '';
        }
        const picked = list.filter((t) => String(t.id) === String(titleId))[0];
        const rejected = (records || []).some(
          (r) => String(r.orderId) === String(orderId) && r.status === 'REJECTED'
        );
        this.setData({
          order,
          rejected,
          titles: list.map((t) => Object.assign({}, t, { isOn: String(t.id) === String(titleId) })),
          titleId,
          /* 邮箱：优先沿用抬头上记过的邮箱，避免每次重填 */
          email: this.data.email || (picked && picked.email) || '',
          loading: false,
        });
      })
      .catch((e) => {
        this.setData({ loading: false });
        toastError(e, '开票信息加载失败');
      });
  },

  onPickTitle(e) {
    const id = String(e.currentTarget.dataset.id);
    const picked = this.data.titles.filter((t) => String(t.id) === id)[0];
    this.setData({
      titleId: id,
      titles: this.data.titles.map((t) => Object.assign({}, t, { isOn: String(t.id) === id })),
      email: (picked && picked.email) || this.data.email,
    });
  },

  goTitles() {
    wx.navigateTo({ url: '/packageUser/pages/invoice-title/invoice-title' });
  },

  onEmail(e) {
    this.setData({ email: e.detail.value });
  },

  onAgree() {
    this.setData({ agree: !this.data.agree });
  },

  goNotice() {
    wx.navigateTo({ url: '/packageUser/pages/agreement-detail/agreement-detail?code=invoice-notice' });
  },

  onSubmit() {
    if (this.data.submitting) return;
    if (!this.data.titles.length || !this.data.titleId) return toast('请先添加并选择发票抬头');
    const email = String(this.data.email || '').trim();
    if (!EMAIL_RE.test(email)) return toast('请填写正确的接收邮箱');
    if (!this.data.agree) return toast('请先阅读并同意《开票须知》');

    this.setData({ submitting: true });
    invoiceApi
      .apply({ orderId: this.data.orderId, titleId: Number(this.data.titleId), email })
      .then((r) => {
        this.setData({ submitting: false });
        wx.showModal({
          title: '申请已提交',
          content: (r && r.resubmit ? '已重新提交开票申请。' : '开票申请已提交。') +
            '商家开具后将发送至 ' + email + '，可在「发票管理 → 开票历史」查看进度。',
          showCancel: false,
          confirmText: '知道了',
          confirmColor: '#C62828',
          complete: () => wx.navigateBack(),
        });
      })
      .catch((e) => {
        this.setData({ submitting: false });
        toastError(e, '提交失败');
      });
  },
});
