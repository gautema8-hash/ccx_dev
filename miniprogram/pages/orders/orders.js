const orderService = require('../../services/order');
const config = require('../../utils/config');
const { confirm, toast } = require('../../utils/util');

Page({
  data: {
    themeStyle: '',
    filters: orderService.FILTERS,
    filter: 'all',
    orders: [],
    counts: {},
    loading: true,
    hasMore: false,
  },

  onLoad() {
    this.load();
  },

  onShow() {
    require('../../services/chain').applyTheme(this);
    // 从详情页返回时刷新状态
    if (this.loadedOnce) this.load();
  },

  onUnload() {
    if (this._navTimer) {
      clearTimeout(this._navTimer);
      this._navTimer = null;
    }
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    // Mock 模式为本地数组，无分页；真实环境在这里累加 page
    if (!this.data.hasMore) return;
  },

  load() {
    this.setData({ loading: true });
    return orderService
      .listOrders(this.data.filter)
      .then((orders) => {
        this.loadedOnce = true;
        this.setData(
          {
            orders,
            loading: false,
            // 注意：必须传入刚拿到的 orders，不能用 this.data.orders
            // （setData 尚未生效，this.data.orders 还是上一次的列表）
            counts: this.buildCounts(orders),
          },
          () => wx.stopPullDownRefresh()
        );
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.stopPullDownRefresh();
        toast((err && err.message) || '订单加载失败');
      });
  },

  /** 顶部筛选角标：只统计「进行中」 */
  buildCounts(list) {
    const orders = list || [];
    return this.data.filter === 'all'
      ? { ongoing: orders.filter((o) => orderService.isOngoing(o.status)).length }
      : {};
  },

  onFilterTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.filter) return;
    this.setData({ filter: key }, () => this.load());
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + id });
  },

  onCancel(e) {
    const id = e.currentTarget.dataset.id;
    confirm('确定取消这笔订单吗？').then((ok) => {
      if (!ok) return;
      orderService
        .cancelOrder(id, '用户主动取消')
        .then(() => {
          toast('已取消', 'success');
          this.load();
        })
        .catch((err) => toast((err && err.message) || '取消失败'));
    });
  },

  onPay(e) {
    const id = e.currentTarget.dataset.id;
    // 支付模式由服务端 PAY_MODE 决定，服务层已封装（mock 时自动弹本地收银台）
    wx.showLoading({ title: '支付中', mask: true });
    orderService
      .payOrder(id)
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '支付成功', icon: 'success' });
        this.load();
      })
      .catch((err) => {
        wx.hideLoading();
        if (err && err.code === 'CANCEL') return;
        toast((err && err.message) || '支付失败');
      });
  },

  onReorder(e) {
    const id = e.currentTarget.dataset.id;
    orderService
      .reorder(id)
      .then(() => {
        wx.showToast({ title: '已加入购物车', icon: 'success' });
        this._navTimer = setTimeout(() => {
          this._navTimer = null;
          wx.switchTab({ url: '/pages/cart/cart' });
        }, 700);
      })
      .catch(() => toast('操作失败'));
  },

  goMenu() {
    wx.switchTab({ url: '/pages/menu/menu' });
  },
});
