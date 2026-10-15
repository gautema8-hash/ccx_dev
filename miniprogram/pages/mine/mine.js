const auth = require('../../utils/auth');
const cart = require('../../utils/cart');
const userService = require('../../services/user');
const orderService = require('../../services/order');
const menuService = require('../../services/menu');
const config = require('../../utils/config');
const { confirm, toast } = require('../../utils/util');
const { toastError } = require('../../utils/request');

Page({
  data: {
    themeStyle: '',
    user: {},
    stats: { orderCount: 0, ongoingCount: 0, couponCount: 0 },
    store: null,
    shop: {},
    version: config.VERSION,
    /* ---- 用户卡展示态（由 syncProfile 统一派生，避免 WXML 里堆判断） ---- */
    avatarText: '客', // 无头像时的文字占位
    avatarBroken: false, // 头像 URL 加载失败 → 回退文字
    displayName: '未登录', // 昵称行的展示文案
    isLogin: false,
    hasPending: false, // 有未保存的头像/昵称改动
  },

  onLoad() {
    this.setData({ user: auth.localUser() || getApp().globalData.userInfo || {} });
    this.syncProfile();
    menuService
      .getMenu()
      .then((menu) => this.setData({ shop: menu.shop }))
      .catch(() => {});
  },

  onShow() {
    require('../../services/chain').applyTheme(this);
    this.setData({ store: require('../../services/chain').currentStore() });
    this.refreshUser();
    this.refreshStats();
  },

  refreshUser() {
    const user = auth.localUser() || getApp().globalData.userInfo;
    if (user) this.setData({ user });
    this.syncProfile();
  },

  /**
   * 由 user 派生出头像与名字的展示态
   *
   * 为什么要单独抽：昵称/头像有「未登录 / 已登录未设置 / 已设置 / 加载失败」四种组合，
   * 全写在 WXML 里会变成一长串三元表达式，既难读又容易漏状态（比如未登录却显示「铜签会员」）。
   * 这里统一算好，WXML 只负责渲染。
   */
  syncProfile() {
    const user = this.data.user || {};
    const isLogin = !!(user.id || user.openid);
    const nickname = String(user.nickname || '').trim();

    let displayName;
    if (!isLogin) displayName = '未登录';
    else if (nickname) displayName = nickname;
    else if (user.phoneMask) displayName = user.phoneMask;
    else displayName = '微信用户';

    /* 头像占位文字：优先昵称首字，其次固定字，保证任何状态都不空白 */
    let avatarText = '客';
    if (nickname) avatarText = Array.from(nickname)[0] || '客';
    else if (!isLogin) avatarText = '游';

    this.setData({
      isLogin,
      displayName,
      avatarText,
      /* 换了头像 URL 就重置失败态，否则新图会被旧的失败标记挡住 */
      avatarBroken: user.avatar ? this.data.avatarBroken : false,
    });
  },

  /** 头像加载失败（链接失效/被回收）→ 回退到文字头像，不留白块 */
  onAvatarError() {
    this.setData({ avatarBroken: true });
  },

  refreshStats() {
    /* 统计走服务端，未登录/离线时降级为本地可见的最小信息，不报错打断页面 */
    auth
      .fetchStats()
      .then((s) => this.setData({ stats: s }))
      .catch(() =>
        orderService
          .listOrders('all')
          .then((orders) =>
            this.setData({
              stats: {
                orderCount: orders.length,
                ongoingCount: orders.filter((o) => orderService.isOngoing(o.status)).length,
                couponCount: 0,
              },
            })
          )
          .catch(() => {})
      );
  },

  /* ------------------------- 用户资料 ------------------------- */

  onChooseAvatar(e) {
    const tempPath = e.detail && e.detail.avatarUrl;
    if (!tempPath) return;
    // 先存到本地持久目录，避免临时文件被回收（真实环境上传后再落库）
    const user = Object.assign({}, this.data.user, { avatar: tempPath });
    this.setData({ user, avatarBroken: false, hasPending: true });
    this.syncProfile();
    this.pendingAvatar = tempPath;
  },

  onNickBlur(e) {
    const nickname = ((e.detail && e.detail.value) || '').trim();
    if (!nickname || nickname === String(this.data.user.nickname || '')) return;
    this.setData({ 'user.nickname': nickname, hasPending: true });
    this.syncProfile();
    this.pendingNickname = nickname;
  },

  onSaveProfile() {
    const payload = {};
    if (this.pendingAvatar) payload.avatar = this.pendingAvatar;
    if (this.pendingNickname) payload.nickname = this.pendingNickname;
    if (!Object.keys(payload).length) {
      toast('先修改头像或昵称');
      return;
    }
    wx.showLoading({ title: '保存中', mask: true });
    auth
      .updateProfile(payload)
      .then((user) => {
        wx.hideLoading();
        getApp().globalData.userInfo = user;
        this.pendingAvatar = null;
        this.pendingNickname = null;
        this.setData({ user });
        /* 先清 pending 再派生：否则保存成功后「保存」按钮不会消失 */
        this.setData({ hasPending: false });
        this.syncProfile();
        toast('已保存', 'success');
      })
      .catch(() => {
        wx.hideLoading();
        toast('保存失败，请重试');
      });
  },

  /* ------------------------- 入口 ------------------------- */

  goOrders() {
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  goCoupon() {
    wx.navigateTo({ url: '/packageUser/pages/coupon/coupon' });
  },

  goVoucher() {
    wx.navigateTo({ url: '/pages/voucher/voucher' });
  },

  goStoreList() {
    wx.navigateTo({ url: '/pages/store-list/store-list' });
  },

  callShop() {
    wx.makePhoneCall({ phoneNumber: config.SERVICE_PHONE, fail: () => {} });
  },

  openLocation() {
    wx.openLocation({
      latitude: 39.9403,
      longitude: 116.4216,
      name: '老北京麻辣串串香·簋街总店',
      address: (this.data.shop && this.data.shop.address) || '',
      scale: 17,
      fail: () => toast('打开地图失败'),
    });
  },

  showPointsRule() {
    wx.showModal({
      title: '积分说明',
      content: '消费 1 元累计 1 积分，100 积分可抵 1 元。积分在订单完成后 1 分钟到账。',
      showCancel: false,
      confirmColor: '#C62828',
    });
  },

  showAbout() {
    wx.showModal({
      title: '关于我们',
      content: `老北京麻辣串串香 · 点单小程序 v${config.VERSION}\n\n现串现涮，人均约 ¥68\n营业时间：${(this.data.shop && this.data.shop.openTime) || ''}`,
      showCancel: false,
      confirmColor: '#C62828',
    });
  },

  /** 调试用：一键清空本地数据（购物车 / 订单 / 登录态 / 缓存） */
  resetLocal() {
    confirm('将清空本地购物车、订单记录与登录态，确定继续？').then((ok) => {
      if (!ok) return;
      cart.clearAll();
      wx.removeStorageSync('lbz_orders_v1');
      wx.removeStorageSync('lbz_pickup_seq');
      wx.removeStorageSync('lbz_invoice_v1');
      auth.logout();
      getApp().globalData.menuCache = null;
      getApp().syncCartBadge();
      this.setData({ stats: { orderCount: 0, ongoingCount: 0, couponCount: 0 } });
      toast('已清空本地数据', 'success');
    });
  },

  /* ------------------------- 发票抬头 ------------------------- */

  onInvoice() {
    const that = this;
    wx.showLoading({ title: '加载中', mask: true });
    userService
      .listInvoice()
      .then((list) => {
        wx.hideLoading();
        const labels = list.map(
          (t) => (t.isDefault ? '⭐ ' : '') + t.title + (t.taxNo ? ' · ' + t.taxNo : '')
        );
        labels.push('➕ 新增抬头');
        wx.showActionSheet({
          itemList: labels.slice(0, 6),
          success(res) {
            if (res.tapIndex === labels.length - 1) return that.addInvoice();
            const t = list[res.tapIndex];
            if (!t) return;
            wx.showActionSheet({
              itemList: ['删除该抬头'],
              success(r2) {
                if (r2.tapIndex !== 0) return;
                userService
                  .deleteInvoice(t.id)
                  .then(() => {
                    toast('已删除', 'success');
                    that.onInvoice();
                  })
                  .catch((e) => toastError(e));
              },
              fail: () => {},
            });
          },
          fail: () => {},
        });
      })
      .catch((e) => {
        wx.hideLoading();
        toastError(e);
      });
  },

  addInvoice() {
    const that = this;
    wx.showModal({
      title: '新增发票抬头',
      editable: true,
      placeholderText: '个人姓名 或 公司名称',
      confirmColor: '#C62828',
      success(r1) {
        if (!r1.confirm) return;
        const title = (r1.content || '').trim();
        if (!title) return toast('请填写抬头');
        wx.showModal({
          title: '纳税人识别号',
          editable: true,
          placeholderText: '公司抬头必填，个人可留空',
          confirmColor: '#C62828',
          success(r2) {
            const taxNo = (r2.content || '').trim();
            userService
              .saveInvoice({ title, taxNo, titleType: taxNo ? 'company' : 'personal' })
              .then(() => {
                toast('已保存', 'success');
                that.onInvoice();
              })
              .catch((e) => toastError(e));
          },
        });
      },
    });
  },

  /* ------------------------- 手机号 ------------------------- */

  onBindPhone(e) {
    const detail = e && e.detail ? e.detail : {};
    if (!detail.encryptedData && !detail.code) {
      toast('未获取到手机号授权');
      return;
    }
    wx.showLoading({ title: '绑定中', mask: true });
    auth
      .bindPhone(detail)
      .then((r) => {
        wx.hideLoading();
        toast('已绑定 ' + (r.phoneMask || ''), 'success');
        this.refreshUser();
      })
      .catch((err) => {
        wx.hideLoading();
        toastError(err);
      });
  },

  onShareAppMessage() {
    return {
      title: '老北京麻辣串串香 · 现串现涮，快来一起撸串',
      path: '/pages/menu/menu',
    };
  },

  onShareTimeline() {
    return { title: '老北京麻辣串串香 · 桌边扫码即点' };
  },
});
