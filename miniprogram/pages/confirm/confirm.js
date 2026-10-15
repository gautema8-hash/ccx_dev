const cart = require('../../utils/cart');
const orderService = require('../../services/order');
const config = require('../../utils/config');
const mockCoupon = require('../../mock/coupon');
const { fen2yuan, toast } = require('../../utils/util');
const { request } = require('../../utils/request');

const EMPTY_SUMMARY = {
  goodsAmount: 0,
  soupFee: 0,
  packFee: 0,
  total: 0,
  goodsText: '0.00',
  soupFeeText: '0.00',
  packFeeText: '0.00',
  totalText: '0.00',
};

Page({
  data: {
    themeStyle: '',
    items: [],
    count: 0,
    diningTypeText: '堂食',
    tableNo: '',
    peopleCount: 2,
    soupName: '未选择',
    dipsText: '未选择',
    remark: '',
    summary: EMPTY_SUMMARY,
    coupons: [],
    coupon: null,
    discount: 0,
    discountText: '0.00',
    payText: '0.00',
    usableCount: 0,
    submitting: false,
  },

  onLoad() {
    /**
     * 下单前兜底匹配最近门店
     * 正常路径上菜单页已经选好门店；但从「购物车 / 分享链接」直接进结算页时可能还是空，
     * 这里补一次自动匹配，保证订单一定落到「距用户最近的门店」而不是服务端默认店。
     * 定位失败不阻塞下单（服务端会退回默认门店）。
     */
    require('../../services/chain')
      .autoPickNearestStore()
      .catch(() => {})
      .then(() => {
        this.loadCoupons();
        this.refresh();
      });
  },

  onShow() {
    require('../../services/chain').applyTheme(this);
    this.readPickedCoupon();
    this.refresh();
  },

  onUnload() {
    if (this._navTimer) {
      clearTimeout(this._navTimer);
      this._navTimer = null;
    }
  },

  /* ------------------------- 数据 ------------------------- */

  loadCoupons() {
    const done = (list) => {
      this.setData({ coupons: list }, () => this.recalc());
    };
    if (config.USE_MOCK) {
      done(mockCoupon.COUPONS);
      return;
    }
    /* 状态码是大小写敏感的（UNUSED / USED），写成小写会查回空列表 */
    const storeId = (require('../../services/chain').currentStore() || {}).id || '';
    request({ url: '/user/coupons', data: { status: 'UNUSED', storeId } })
      .then(done)
      .catch(() => done([]));
  },

  refresh() {
    const state = cart.get();
    const summary = cart.getSummary();
    const items = cart.toOrderItems().map((i) =>
      Object.assign({}, i, { amountText: fen2yuan(i.amount) })
    );
    this.setData(
      {
        items,
        count: summary.count,
        diningTypeText: state.diningType === 'takeout' ? '到店自取' : '堂食',
        tableNo: state.tableNo,
        peopleCount: state.peopleCount,
        soupName: state.soup ? state.soup.name : '未选择',
        dipsText: state.dips.length ? state.dips.map((d) => d.name).join('、') : '未选择',
        remark: state.remark,
        summary,
      },
      () => this.recalc()
    );
  },

  /** 结算页返回时读取优惠券选择结果（分包页面写入 globalData） */
  readPickedCoupon() {
    const app = getApp();
    const picked = app.globalData.__couponPicked;
    if (!picked) return;
    delete app.globalData.__couponPicked;
    if (picked.orderToken && picked.orderToken !== this.orderToken) return;
    this.setData({ coupon: picked.coupon || null });
  },

  /**
   * 重算优惠与实付
   *
   * 真实后端模式下**必须问服务端**（POST /coupons/usable），不能再用本地 mock 口径：
   * 服务端支持折扣券（8.8 折）、锅底券、门店适用范围，本地 mock 只认满减与锅底，
   * 两边口径不一致就会出现「页面显示省 ¥10、实际只省 ¥8」的资损争议。
   * 领券中心分包页已用服务端返回的 applicable / estimateDiscount，这里必须同源。
   */
  recalc() {
    const summary = this.data.summary || EMPTY_SUMMARY;
    const coupon = this.data.coupon;

    if (config.USE_MOCK) {
      const discount = mockCoupon.calcDiscount(coupon, summary);
      const usable = this.data.coupons.filter((c) => summary.goodsAmount + summary.soupFee >= c.threshold);
      this.setData({
        discount,
        discountText: fen2yuan(discount),
        payText: fen2yuan(Math.max(0, summary.total - discount)),
        usableCount: usable.length,
      });
      return;
    }

    const storeId = (require('../../services/chain').currentStore() || {}).id || '';
    const goodsAmount = summary.goodsAmount;
    const soupFee = summary.soupFee;
    /* 同一金额上下文只问一次，避免购物车微调时反复打接口 */
    const key = storeId + '|' + goodsAmount + '|' + soupFee;
    this._usableKey = key;

    request({
      url: '/coupons/usable',
      method: 'POST',
      data: { storeId, goodsAmount, soupFee },
      idempotent: true,
    })
      .then((res) => {
        if (this._usableKey !== key) return; // 期间又变了，以最新一次为准
        const list = (res && res.list) || [];
        const hit = coupon ? list.filter((c) => c.id === coupon.id)[0] : null;
        /* 已选的券不在可用列表里 —— 门店不适用 / 未达门槛 / 已被用掉，直接清掉避免带到下单 */
        const used = coupon && !hit ? null : coupon;
        const discount = hit ? Number(hit.estimateDiscount) || 0 : 0;
        this.setData({
          coupons: list,
          coupon: used,
          discount,
          discountText: fen2yuan(discount),
          payText: fen2yuan(Math.max(0, summary.total - discount)),
          usableCount: list.length,
        });
      })
      .catch(() => {
        /* 问不到就按「不用券」展示，但绝不臆造一个折扣金额误导用户 */
        this.setData({
          coupon: null,
          discount: 0,
          discountText: '0.00',
          payText: fen2yuan(summary.total),
          usableCount: 0,
        });
      });
  },

  /* ------------------------- 优惠券 ------------------------- */

  goCoupon() {
    /* 用一个本地会话标记避免上一次的选择串味。
       参数名必须叫 orderToken —— 叫 token 会被后续维护者误当作鉴权令牌（它并不是）。 */
    this.orderToken = 'tk_' + Date.now();
    wx.navigateTo({
      url: `/packageUser/pages/coupon/coupon?select=1&orderToken=${this.orderToken}&current=${this.data.coupon ? this.data.coupon.id : ''}`,
    });
  },

  /* ------------------------- 提交与支付 ------------------------- */

  onSubmit() {
    if (this.data.submitting) return;
    if (!this.data.items.length) {
      toast('购物车为空');
      return;
    }
    const state = cart.get();
    const summary = this.data.summary;
    const addCtx = getApp().globalData.addDishFrom || null;
    const payload = {
      items: cart.toOrderItems(),
      soup: state.soup,
      dips: state.dips,
      diningType: state.diningType,
      tableNo: state.tableNo,
      peopleCount: state.peopleCount,
      remark: state.remark,
      coupon: this.data.coupon,
      /** 连锁：订单必须归属到具体门店（库存扣在该门店上） */
      storeId: (require('../../services/chain').currentStore() || {}).id || '',
      /** 加菜场景：新订单挂到上游订单上 */
      parentOrderId: addCtx && addCtx.parentOrderId ? addCtx.parentOrderId : '',
      amount: {
        goods: summary.goodsAmount,
        soupFee: summary.soupFee,
        packFee: summary.packFee,
        discount: this.data.discount,
        pay: Math.max(0, summary.total - this.data.discount),
      },
    };

    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中', mask: true });

    orderService
      .createOrder(payload)
      .then((order) => {
        wx.hideLoading();
        return this.payFlow(order);
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        toast((err && err.message) || '提交订单失败，请重试');
      });
  },

  /**
   * 支付前置：
   * 支付模式完全由服务端的 PAY_MODE 决定，客户端不自己判断 ——
   * 服务端 prepay 返回 mock:true 时会自动走本地收银台并回调 /mock-pay，
   * 返回真实支付参数时走 wx.requestPayment。两条路都汇到同一个结算逻辑。
   */
  payFlow(order) {
    return this.doPay(order);
  },

  doPay(order) {
    wx.showLoading({ title: '支付中', mask: true });
    return orderService
      .payOrder(order.id)
      .then((paid) => {
        wx.hideLoading();
        // 支付成功才清空菜品，保留锅底/蘸料/就餐方式，方便「再来一单」
        cart.clear(false);
        // 加菜上下文用完即清，避免下一单被误挂到旧订单上
        getApp().globalData.addDishFrom = null;
        this.setData({ submitting: false });
        wx.showToast({ title: '支付成功', icon: 'success', duration: 900 });
        /* 保存句柄：页面卸载（用户返回/被回收）时必须清掉，
           否则会在已销毁的页面上执行跳转与 setData */
        this._navTimer = setTimeout(() => {
          this._navTimer = null;
          wx.redirectTo({ url: '/pages/order-detail/order-detail?id=' + (paid && paid.id ? paid.id : order.id) });
        }, 800);
      })
      .catch((err) => {
        wx.hideLoading();
        if (err && err.code === 'CANCEL') return this.afterUnpaid(order, '你取消了支付');
        this.setData({ submitting: false });
        toast((err && err.message) || '支付失败，请重试');
      });
  },

  /** 未支付：订单已落库，引导去订单页继续支付（避免用户以为丢单） */
  afterUnpaid(order, reason) {
    this.setData({ submitting: false });
    return new Promise((resolve) => {
      wx.showModal({
        title: '订单已生成',
        content: `${reason}，订单已保存 15 分钟，可在「订单」中继续支付`,
        showCancel: false,
        confirmText: '查看订单',
        confirmColor: '#C62828',
        complete: () => {
          wx.redirectTo({ url: '/pages/order-detail/order-detail?id=' + order.id });
          resolve();
        },
      });
    });
  },
});
