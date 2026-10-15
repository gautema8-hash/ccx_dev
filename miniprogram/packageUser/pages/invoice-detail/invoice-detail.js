/**
 * 开票详情
 * 展示进度时间线 + 发票信息 + 订单快照；已开具可直接查看/复制发票文件，
 * 已驳回可一键回到申请页修改重提。
 */
const chain = require('../../../services/chain');
const invoiceApi = require('../../../services/invoice');
const { fen2yuan, formatTime, toast } = require('../../../utils/util');
const { toastError } = require('../../../utils/request');

const DESC = {
  PENDING: '商家将在 24 小时内受理，请留意邮箱',
  PROCESSING: '商家正在开票，通常 1 个工作日内完成',
  ISSUED: '发票已开具，可下载保存或转发报销',
  REJECTED: '申请被驳回，可修改抬头后重新提交',
};

Page({
  data: {
    themeStyle: '',
    loading: true,
    id: '',
    rec: null,
    steps: [],
    statusDesc: '',
    amountYuan: '0.00',
    issuedText: '',
    diningText: '',
    payText: '',
  },

  onLoad(query) {
    this.setData({ id: (query && query.id) || '' });
  },

  onShow() {
    chain.applyTheme(this);
    this.fetch();
  },

  fetch() {
    const id = this.data.id;
    if (!id) {
      this.setData({ loading: false });
      return Promise.resolve();
    }
    this.setData({ loading: true });
    return invoiceApi
      .recordDetail(id)
      .then((rec) => {
        if (!rec) {
          this.setData({ rec: null, loading: false });
          return;
        }
        const order = rec.order
          ? Object.assign({}, rec.order, {
              amountText: fen2yuan(rec.order.amount),
              items: (rec.order.items || []).map((i) =>
                Object.assign({}, i, { amountText: fen2yuan(i.amount) })
              ),
            })
          : null;

        this.setData({
          rec: Object.assign({}, rec, { order }),
          amountYuan: fen2yuan(rec.amount),
          statusDesc: DESC[rec.status] || '',
          issuedText: rec.issuedAt ? formatTime(rec.issuedAt, true) : '',
          diningText:
            (order && (order.diningType === 'takeout' ? '到店自取' : '堂食')) +
            (order && order.tableNo ? ' · ' + order.tableNo + ' 号桌' : '') +
            (order && order.pickupNo && order.diningType === 'takeout' ? ' · 取餐号 ' + order.pickupNo : ''),
          payText: order && order.payTime ? formatTime(order.payTime, true) : '',
          steps: this.buildSteps(rec),
          loading: false,
        });
      })
      .catch((e) => {
        this.setData({ loading: false });
        toastError(e, '开票详情加载失败');
      });
  },

  /** 三步时间线：提交申请 → 商家受理 → 发票开具（驳回时第三步变失败态） */
  buildSteps(rec) {
    const accepted = rec.status === 'PROCESSING' || rec.status === 'ISSUED';
    const issued = rec.status === 'ISSUED';
    const rejected = rec.status === 'REJECTED';
    return [
      { key: 'apply', title: '提交申请', done: true, timeText: formatTime(rec.appliedAt, true) },
      {
        key: 'accept',
        title: '商家受理',
        done: accepted,
        timeText: accepted ? '已受理' : rejected ? '未通过' : '等待商家受理',
      },
      {
        key: 'issue',
        title: rejected ? '申请驳回' : '发票开具',
        done: issued,
        fail: rejected,
        timeText: issued ? formatTime(rec.issuedAt, true) : rejected ? '可修改后重新申请' : '等待开票',
      },
    ];
  },

  openInvoice() {
    const url = this.data.rec && this.data.rec.invoiceUrl;
    if (!url) return;
    /* 老机型对 pdf 的 openDocument 支持更好；下载失败时退化为复制链接 */
    wx.showLoading({ title: '打开中', mask: true });
    wx.downloadFile({
      url,
      success: (r) => {
        wx.hideLoading();
        if (r.statusCode !== 200) return toast('发票文件暂不可用');
        wx.openDocument({
          filePath: r.tempFilePath,
          showMenu: true,
          fail: () => this.copyInvoice(),
        });
      },
      fail: () => {
        wx.hideLoading();
        toast('下载失败，可复制链接后在浏览器打开');
      },
    });
  },

  copyInvoice() {
    const url = this.data.rec && this.data.rec.invoiceUrl;
    if (!url) return;
    wx.setClipboardData({ data: url, success: () => toast('发票链接已复制', 'success') });
  },

  reapply() {
    wx.navigateTo({
      url: '/packageUser/pages/invoice-apply/invoice-apply?orderId=' + (this.data.rec.orderId || ''),
    });
  },

  goOrder() {
    if (!this.data.rec.order) return;
    wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + this.data.rec.order.id });
  },

  callShop() {
    const phone = this.data.rec && this.data.rec.order && this.data.rec.order.storePhone;
    if (!phone) {
      toast('门店电话请在「选择门店」中查看');
      return;
    }
    wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },
});
