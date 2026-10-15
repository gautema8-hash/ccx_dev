const cart = require('../../../utils/cart');
const chain = require('../../../services/chain');
const config = require('../../../utils/config');
const { fen2yuan, toast } = require('../../../utils/util');
const { toastError } = require('../../../utils/request');

Page({
  data: {
    themeStyle: '',
    tab: 'center',
    status: 'UNUSED',
    loading: true,
    store: null,
    centerList: [],
    mineList: [],
    counts: { unused: 0, used: 0 },
    /** 结算页进入：选券模式，选中后回传并返回 */
    selectMode: false,
    token: '',
    currentId: '',
  },

  onLoad(query) {
    this.setData({
      selectMode: query && query.select === '1',
      /* 兼容旧参数名 token，但主用 orderToken（避免与鉴权令牌混淆） */
      token: (query && (query.orderToken || query.token)) || '',
      currentId: (query && query.current) || '',
      tab: query && query.select === '1' ? 'mine' : 'center',
    });
    this.syncStore();
  },

  onShow() {
    chain.applyTheme(this);
    this.syncStore();
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  syncStore() {
    this.setData({ store: chain.currentStore() });
  },

  load() {
    this.setData({ loading: true });
    const store = this.data.store;
    const jobs = [];
    if (config.USE_MOCK) {
      const mockCoupon = require('../../../mock/coupon');
      jobs.push(Promise.resolve({ list: mockCoupon.COUPONS.map((c) => Object.assign({}, c, { usable: true, valueText: fen2yuan(c.value), thresholdText: c.threshold ? '满 ' + fen2yuan(c.threshold) : '无门槛', storeScopeText: '全品牌通用', canReceive: true, issued: 100, perUser: 1, dayLimit: 0, expireAt: c.expireAt, scope: c.scope, type: c.type, userCouponId: c.id })) }));
      jobs.push(Promise.resolve([]));
    } else {
      jobs.push(chain.couponCenter(store ? store.id : '').catch(() => ({ list: [] })));
      jobs.push(
        chain
          .myCoupons(this.data.status, {
            withContext: 1,
            storeId: store ? store.id : '',
            goodsAmount: cart.getSummary().goodsAmount,
            soupFee: cart.getSummary().soupFee,
          })
          .catch(() => [])
      );
    }
    return Promise.all(jobs).then((res) => {
      const center = (res[0] && res[0].list) || [];
      const mine = res[1] || [];
      const unused = mine.filter((c) => c.usable).length;
      const used = mine.filter((c) => !c.usable).length;
      this.setData({
        loading: false,
        centerList: center.map((c) => Object.assign({}, c, { issued: c.issued || 0 })),
        mineList: mine.map((c) =>
          Object.assign({}, c, {
            valueText: c.type === 'DISCOUNT' ? c.value / 10 + '折' : '¥' + fen2yuan(c.value),
            thresholdText: c.threshold ? '满 ' + fen2yuan(c.threshold) : '无门槛',
            storeScopeText: (c.storeIds && c.storeIds.length ? c.storeIds.length + ' 家指定门店' : '全品牌通用'),
            usedAtText: c.usedAt ? new Date(c.usedAt).toLocaleDateString('zh-CN') : '',
            estimateDiscountText: c.estimateDiscount ? fen2yuan(c.estimateDiscount) : '',
          })
        ),
        counts: { unused: unused, used: used },
      });
    });
  },

  onTab(e) {
    const t = e.currentTarget.dataset.t;
    if (t === this.data.tab) return;
    this.setData({ tab: t }, () => this.load());
  },

  onStatus(e) {
    const s = e.currentTarget.dataset.s;
    if (s === this.data.status) return;
    this.setData({ status: s }, () => this.load());
  },

  pickStore() {
    wx.navigateTo({ url: '/pages/store-list/store-list?from=voucher' });
  },

  goCenter() {
    this.setData({ tab: 'center' }, () => this.load());
  },

  goMenu() {
    wx.switchTab({ url: '/pages/menu/menu' });
  },

  /* ---------------- 领券 ---------------- */
  onReceive(e) {
    const id = e.currentTarget.dataset.id;
    const c = this.data.centerList.filter((x) => x.id === id)[0];
    if (!c) return;
    if (!c.canReceive) return toast(c.receivedCount >= c.perUser ? '该券每人限领 ' + c.perUser + ' 张' : '该券已被领完');

    wx.showLoading({ title: '领取中', mask: true });
    chain
      .receiveCoupon(id, this.data.store ? this.data.store.id : '')
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '领取成功', icon: 'success' });
        this.load();
      })
      .catch((err) => {
        wx.hideLoading();
        toastError(err, '领取失败');
        this.load();
      });
  },

  /* ---------------- 选券（结算页进来） ---------------- */
  onPickMine(e) {
    if (!this.data.selectMode) return;
    const id = e.currentTarget.dataset.id;
    const c = this.data.mineList.filter((x) => x.id === id)[0];
    if (!c) return;
    if (!c.usable) return toast('该券当前不可用');
    if (c.applicable === false) return toast(c.inapplicableReason || '该券不适用于当前订单');
    this.back(c);
  },

  onUseNone() {
    this.back(null);
  },

  /** 回传结果给结算页（分包页用 globalData 回传，避免依赖页面实例） */
  back(coupon) {
    const app = getApp();
    app.globalData.__couponPicked = { orderToken: this.data.token, coupon: coupon || null };
    wx.navigateBack({ delta: 1 });
  },
});
