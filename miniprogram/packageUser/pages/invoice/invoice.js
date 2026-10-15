const chain = require('../../../services/chain');
const invoiceApi = require('../../../services/invoice');
const { fen2yuan, formatTime } = require('../../../utils/util');
const { toastError } = require('../../../utils/request');

Page({
  data: {
    themeStyle: '',
    tab: 'orders', // orders 待开票 | history 开票历史
    orders: [],
    records: [],
    loading: true,
  },

  onShow() {
    chain.applyTheme(this);
    this.fetch();
  },

  onPullDownRefresh() {
    this.fetch().then(() => wx.stopPullDownRefresh());
  },

  fetch() {
    this.setData({ loading: true });
    const tasks = [
      invoiceApi
        .invoicableOrders()
        .then((list) =>
          this.setData({
            orders: (list || []).map((o) =>
              Object.assign({}, o, { amountYuan: fen2yuan(o.amount), timeText: formatTime(o.time, true) })
            ),
          })
        ),
      invoiceApi
        .listRecords()
        .then((list) =>
          this.setData({
            records: (list || []).map((r) =>
              Object.assign({}, r, { amountYuan: fen2yuan(r.amount), timeText: formatTime(r.appliedAt, true) })
            ),
          })
        ),
    ];
    return Promise.all(tasks)
      .catch((e) => toastError(e, '开票信息加载失败'))
      .then(() => this.setData({ loading: false }));
  },

  onTab(e) {
    const t = e.currentTarget.dataset.t;
    if (t === this.data.tab) return;
    this.setData({ tab: t });
    this.fetch();
  },

  goTitles() {
    wx.navigateTo({ url: '/packageUser/pages/invoice-title/invoice-title' });
  },

  goApply(e) {
    wx.navigateTo({ url: '/packageUser/pages/invoice-apply/invoice-apply?orderId=' + e.currentTarget.dataset.id });
  },

  goDetail(e) {
    wx.navigateTo({ url: '/packageUser/pages/invoice-detail/invoice-detail?id=' + e.currentTarget.dataset.id });
  },
});
