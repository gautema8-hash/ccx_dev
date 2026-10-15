const orderService = require('../../services/order');
const config = require('../../utils/config');
const { confirm, toast } = require('../../utils/util');

const POLL_INTERVAL = 5000;

Page({
  data: {
    themeStyle: '',
    order: null,
    /** 是否已支付（决定是否展示取餐码） */
    showPickup: false,
    /** 轮询中标记，页面上有小红点提示 */
    polling: false,
  },

  onLoad(query) {
    this.orderId = query.id;
    if (!this.orderId) {
      toast('缺少订单号');
      this._navTimer = setTimeout(() => {
        this._navTimer = null;
        wx.navigateBack();
      }, 800);
      return;
    }
    this.load();
  },

  onShow() {
    require('../../services/chain').applyTheme(this);
    if (this.orderId) this.load();
  },

  onHide() {
    this.stopPoll();
  },

  onUnload() {
    this.stopPoll();
    if (this._navTimer) {
      clearTimeout(this._navTimer);
      this._navTimer = null;
    }
  },

  /* ------------------------- 加载与轮询 ------------------------- */

  load() {
    return orderService
      .getOrder(this.orderId)
      .then((order) => this.apply(order))
      .catch((err) => {
        toast((err && err.message) || '订单加载失败');
      });
  },

  apply(order) {
    const showPickup =
      order.status !== orderService.STATUS.UNPAID &&
      order.status !== orderService.STATUS.CANCELED;
    this.setData({ order, showPickup }, () => this.syncPoll(order));
  },

  /** 未付款不轮询（用户可能正在微信收银台）；已付款且未结束才轮询 */
  syncPoll(order) {
    const shouldPoll =
      orderService.isOngoing(order.status) && order.status !== orderService.STATUS.UNPAID;
    if (shouldPoll) this.startPoll();
    else this.stopPoll();
  },

  /**
   * 轮询拉取最新状态
   * Mock 模式走本地状态推导；真实模式必须重新请求服务端 ——
   * 否则用户在详情页干等，永远看不到「商家已接单 / 已出餐」。
   */
  pollOnce() {
    if (config.USE_MOCK) {
      const order = orderService.refreshStatus(this.orderId);
      if (order) this.apply(order);
      return;
    }
    orderService
      .getOrder(this.orderId)
      .then((order) => {
        if (order) this.apply(order);
      })
      .catch(() => {
        /* 轮询失败静默处理，下次再试；不要弹 toast 打断用户 */
      });
  },

  startPoll() {
    if (this.timer) return;
    this.setData({ polling: true });
    this.timer = setInterval(() => this.pollOnce(), POLL_INTERVAL);
  },

  stopPoll() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.data.polling) this.setData({ polling: false });
  },

  /* ------------------------- 操作 ------------------------- */

  onPay() {
    const order = this.data.order;
    const run = () => {
      wx.showLoading({ title: '支付中', mask: true });
      orderService
        .payOrder(this.orderId)
        .then((paid) => {
          wx.hideLoading();
          wx.showToast({ title: '支付成功', icon: 'success' });
          this.apply(paid || order);
        })
        .catch((err) => {
          wx.hideLoading();
          if (err && err.code === 'CANCEL') return;
          toast((err && err.message) || '支付失败');
        });
    };
    run();
  },

  onCancel() {
    confirm('确定取消这笔订单吗？').then((ok) => {
      if (!ok) return;
      orderService
        .cancelOrder(this.orderId, '用户主动取消')
        .then((order) => {
          toast('已取消', 'success');
          this.apply(order);
        })
        .catch(() => toast('取消失败'));
    });
  },

  onFinish() {
    orderService
      .finishOrder(this.orderId)
      .then((order) => {
        this.apply(order);
        wx.showToast({ title: '已确认完成', icon: 'success' });
      })
      .catch(() => toast('操作失败'));
  },

  onReorder() {
    orderService
      .reorder(this.orderId)
      .then(() => {
        wx.showToast({ title: '已加入购物车', icon: 'success' });
        this._navTimer = setTimeout(() => {
          this._navTimer = null;
          wx.switchTab({ url: '/pages/cart/cart' });
        }, 700);
      })
      .catch(() => toast('操作失败'));
  },

  /** 催单：后厨会收到提示（服务端 2 分钟内只允许催一次） */
  onUrge() {
    wx.showLoading({ title: '发送中', mask: true });
    orderService
      .urgeOrder(this.orderId)
      .then((r) => {
        wx.hideLoading();
        wx.showToast({ title: '已催单，后厨正在加速~', icon: 'none' });
        this.setData({ 'order.urgeCount': (r && r.urgeCount) || 1 });
      })
      .catch((e) => {
        wx.hideLoading();
        toast((e && e.message) || '催单失败');
      });
  },

  /** 申请退款：填原因 → 提交门店审核 */
  onRefund() {
    const that = this;
    wx.showModal({
      title: '申请退款',
      editable: true,
      placeholderText: '请填写退款原因（如：点错了 / 已离店）',
      confirmText: '提交申请',
      confirmColor: '#C62828',
      success(res) {
        if (!res.confirm) return;
        const reason = (res.content || '').trim() || '用户申请退款';
        wx.showLoading({ title: '提交中', mask: true });
        orderService
          .applyRefund(that.orderId, reason)
          .then(() => {
            wx.hideLoading();
            wx.showModal({
              title: '已提交',
              content: '退款申请已提交，门店审核通过后原路退回（1-3 个工作日）',
              showCancel: false,
              confirmColor: '#C62828',
            });
            that.load();
          })
          .catch((e) => {
            wx.hideLoading();
            toast((e && e.message) || '提交失败');
          });
      },
    });
  },

  /** 评价：选星级 → 填内容 → 提交（一单一次） */
  onRate() {
    const that = this;
    const scores = ['非常满意 😍', '满意 🙂', '一般 😐', '不太满意 😕', '很差 😡'];
    wx.showActionSheet({
      itemList: scores,
      success(res) {
        const score = 5 - res.tapIndex;
        wx.showModal({
          title: '说说哪里可以更好',
          editable: true,
          placeholderText: '选填，最多 200 字',
          confirmText: '提交评价',
          confirmColor: '#C62828',
          success(r2) {
            if (!r2.confirm) return;
            wx.showLoading({ title: '提交中', mask: true });
            orderService
              .submitFeedback(that.orderId, score, (r2.content || '').slice(0, 200))
              .then(() => {
                wx.hideLoading();
                wx.showToast({ title: '感谢你的评价', icon: 'success' });
                that.setData({ 'order.rated': true });
                that.load();
              })
              .catch((e) => {
                wx.hideLoading();
                toast((e && e.message) || '评价失败');
              });
          },
        });
      },
      fail: () => {},
    });
  },

  /** 加菜：带着桌号与就餐方式回点单页，新订单会挂在当前订单上 */
  onAddDish() {
    const o = this.data.order;
    if (!o) return;
    getApp().globalData.addDishFrom = {
      parentOrderId: o.id,
      tableNo: o.tableNo,
      diningType: o.diningType,
      tableLabel: o.diningType === 'takeout' ? '自取加菜' : o.tableNo + ' 桌加菜',
    };
    wx.switchTab({
      url: '/pages/menu/menu',
      success: () => wx.showToast({ title: '正在为 ' + (o.tableNo || '本单') + ' 加菜', icon: 'none' }),
    });
  },

  callShop() {
    wx.makePhoneCall({ phoneNumber: config.SERVICE_PHONE, fail: () => {} });
  },

  copyOrderNo() {
    wx.setClipboardData({
      data: this.data.order.orderNo,
      success: () => wx.showToast({ title: '订单号已复制', icon: 'none' }),
    });
  },

  onShareAppMessage() {
    return {
      title: '老北京麻辣串串香 · 现串现涮',
      path: '/pages/menu/menu',
    };
  },
});
