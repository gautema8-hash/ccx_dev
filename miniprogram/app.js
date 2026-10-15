const auth = require('./utils/auth');
const cart = require('./utils/cart');
const config = require('./utils/config');
const request = require('./utils/request');
const chain = require('./services/chain');

App({
  globalData: {
    /** @type {null | {id:number, openid:string, nickname:string, avatar:string, phoneMask:string, memberLevel:number, memberName:string, points:number}} */
    userInfo: null,
    shop: null,
    menuCache: null,
    systemInfo: null,
    statusBarHeight: 20,
    launchTs: 0,
    /** 网络是否可用（离线时请求快速失败，页面给可读提示） */
    online: true,
    /** 正在为某桌加菜时，记录上游订单号 */
    addDishFrom: null,
    /** 当前门店（连锁：菜单、库存、核销、主题都按门店走） */
    store: null,
    /** 当前生效主题 */
    theme: null,
    themeStyle: '',
    themeTokens: null,
  },

  onLaunch() {
    this.globalData.launchTs = Date.now();
    this.initSystemInfo();
    this.watchNetwork();
    this.watchError();

    /* 当前门店：先用本地缓存渲染，再异步拉主题（避免首屏白等） */
    this.globalData.store = chain.currentStore();
    chain.loadTheme(this.globalData.store ? this.globalData.store.id : '');

    // 静默登录：拿到 token，不阻塞首屏
    auth
      .ensureLogin()
      .then((user) => {
        this.globalData.userInfo = user;
      })
      .catch((err) => {
        console.warn('[app] 静默登录失败，降级为游客态', err);
      });

    this.syncCartBadge();
    cart.subscribe(() => this.syncCartBadge());
  },

  /** 切换门店后刷新主题（门店级主题优先） */
  refreshTheme(storeId) {
    return chain.loadTheme(storeId || (this.globalData.store ? this.globalData.store.id : ''), true);
  },

  onShow() {
    this.syncCartBadge();
    /* 从后台回前台：检查登录态（可能已过期），过期则静默续期 */
    auth.checkSession().catch(() => {});
  },

  /** 页面不存在时的兜底（防止白屏） */
  onPageNotFound(res) {
    console.warn('[app] page not found:', res && res.path);
    wx.switchTab({ url: '/pages/menu/menu', fail: () => wx.reLaunch({ url: '/pages/menu/menu' }) });
  },

  /** 未捕获的 Promise 异常：不让它静默消失，统一落日志 */
  onUnhandledRejection(res) {
    console.error('[app] unhandledRejection:', res && res.reason);
  },

  initSystemInfo() {
    try {
      const win =
        typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
      this.globalData.systemInfo = win;
      this.globalData.statusBarHeight = win.statusBarHeight || 20;
    } catch (e) {
      this.globalData.statusBarHeight = 20;
    }
  },

  /** 网络状态：全局维护一份，网络层据此快速失败 */
  watchNetwork() {
    const apply = (isConnected) => {
      this.globalData.online = !!isConnected;
      request.setNetworkOnline(!!isConnected);
    };
    wx.getNetworkType({
      success: (r) => apply(r.networkType !== 'none'),
      fail: () => apply(true),
    });
    if (wx.onNetworkStatusChange) {
      wx.onNetworkStatusChange((r) => {
        const wasOnline = this.globalData.online;
        apply(r.isConnected);
        if (!wasOnline && r.isConnected) {
          wx.showToast({ title: '网络已恢复', icon: 'none' });
          /* 网络恢复：清菜单缓存，下次进入拉到最新 */
          try {
            require('./services/menu').clearCache();
          } catch (e) {}
        }
      });
    }
  },

  watchError() {
    if (!wx.onError) return;
    wx.onError((err) => {
      // 生产环境替换为上报接口，采样上报避免刷量
      console.error('[wx.onError]', err);
    });
  },

  syncCartBadge() {
    const count = cart.getSummary().count;
    if (count > 0) {
      wx.setTabBarBadge({ index: 1, text: count > 99 ? '99+' : String(count), fail: () => {} });
    } else {
      wx.removeTabBarBadge({ index: 1, fail: () => {} });
    }
  },

  /** 统一登录入口：供需要登录态的操作调用 */
  ensureLogin() {
    return auth.checkSession().then((ok) => (ok ? auth.ensureLogin() : Promise.reject(new Error('登录失败'))));
  },
});
