/**
 * 连锁能力服务层：门店定位 / 主题 / 团购券 / 领券中心
 * 页面只依赖这一层，不直接发请求。
 */
const config = require('../utils/config');
const { request } = require('../utils/request');

/* ============================ 定位 ============================ */
const LOC_KEY = 'lbz_location_v1';
const STORE_KEY = 'lbz_store_v1';

/**
 * 获取定位（带权限引导与降级）
 * 用户拒绝授权时不报错，返回 { ok:false, reason } 让页面展示「开启定位」引导
 */
function getLocation() {
  return new Promise((resolve) => {
    if (config.USE_MOCK) {
      return resolve({ ok: true, latitude: 39.9403, longitude: 116.4216, mock: true });
    }
    wx.getLocation({
      type: 'gcj02',
      isHighAccuracy: false,
      success: (r) => {
        wx.setStorageSync(LOC_KEY, { lat: r.latitude, lng: r.longitude, ts: Date.now() });
        resolve({ ok: true, latitude: r.latitude, longitude: r.longitude });
      },
      fail: (e) => {
        const msg = String((e && e.errMsg) || '');
        resolve({
          ok: false,
          reason: msg.indexOf('auth deny') > -1 || msg.indexOf('authorize') > -1 ? 'DENIED' : 'FAIL',
          message: msg,
        });
      },
    });
  });
}

/** 缓存的位置（10 分钟内有效，避免频繁调 getLocation 触发系统限制） */
function cachedLocation() {
  const c = wx.getStorageSync(LOC_KEY);
  if (c && c.ts && Date.now() - c.ts < 10 * 60 * 1000) return c;
  return null;
}

/** 引导用户去设置页开启定位 */
function openLocationSetting() {
  return new Promise((resolve) => {
    wx.openSetting({
      success: (r) => resolve(!!(r.authSetting && r.authSetting['scope.userLocation'])),
      fail: () => resolve(false),
    });
  });
}

/** 附近门店 */
function nearbyStores(opts) {
  opts = opts || {};
  const data = {};
  if (opts.latitude && opts.longitude) {
    data.lat = opts.latitude;
    data.lng = opts.longitude;
  }
  if (opts.keyword) data.keyword = opts.keyword;
  if (opts.type) data.type = opts.type;
  return request({ url: '/stores', method: 'GET', data, idempotent: true });
}

function storeDetail(id, opts) {
  opts = opts || {};
  const data = {};
  if (opts.latitude) {
    data.lat = opts.latitude;
    data.lng = opts.longitude;
  }
  return request({ url: '/stores/' + id, method: 'GET', data, idempotent: true });
}

/* ---- 当前门店（下单、看菜单、核销都要用它） ---- */
function currentStore() {
  return wx.getStorageSync(STORE_KEY) || null;
}

function setCurrentStore(store) {
  if (!store) {
    wx.removeStorageSync(STORE_KEY);
    return null;
  }
  const slim = {
    id: store.id,
    name: store.name,
    type: store.type,
    typeText: store.typeText,
    address: store.address,
    phone: store.phone,
    latitude: store.latitude,
    longitude: store.longitude,
    openTime: store.openTime,
    distanceText: store.distanceText,
  };
  wx.setStorageSync(STORE_KEY, slim);
  const app = getApp();
  if (app) app.globalData.store = slim;
  return slim;
}

/** 打开地图导航（保留原有门店导航能力） */
function navigateTo(store) {
  if (!store || !store.latitude) {
    wx.showToast({ title: '该门店未配置坐标', icon: 'none' });
    return;
  }
  wx.openLocation({
    latitude: Number(store.latitude),
    longitude: Number(store.longitude),
    name: store.name,
    address: store.address,
    scale: 17,
    fail: () => wx.showToast({ title: '打开地图失败', icon: 'none' }),
  });
}

/* ============================ 主题 ============================ */
const THEME_KEY = 'lbz_theme_v1';
const THEME_TTL = 5 * 60 * 1000;

const DEFAULT_TOKENS = {
  primary: '#C62828',
  primaryDark: '#9E1B1B',
  primaryWeak: '#FDECEC',
  accent: '#FF8F1F',
  text: '#1F1F1F',
  sub: '#8A8A8E',
  line: '#EDEDF0',
  bg: '#F5F5F7',
  card: '#FFFFFF',
  navBg: '#C62828',
  navText: '#FFFFFF',
  bannerText: '',
  bannerSub: '',
  barBg: '#1F1F1F',
  badge: '',
};

/** 令牌 → 内联 CSS 变量字符串（挂到页面根 view 上，子元素 var() 自动继承） */
function tokensToStyle(tokens) {
  const t = Object.assign({}, DEFAULT_TOKENS, tokens || {});
  return (
    '--c-primary:' + t.primary + ';' +
    '--c-primary-dark:' + t.primaryDark + ';' +
    '--c-primary-weak:' + t.primaryWeak + ';' +
    '--c-accent:' + t.accent + ';' +
    '--c-text:' + t.text + ';' +
    '--c-sub:' + t.sub + ';' +
    '--c-line:' + t.line + ';' +
    '--c-bg:' + t.bg + ';' +
    '--c-card:' + t.card + ';' +
    '--c-bar-bg:' + t.barBg + ';'
  );
}

/**
 * 拉取生效主题
 * @param {string} storeId 传门店 id 才能拿到「门店级」主题
 */
function loadTheme(storeId, force) {
  const cached = wx.getStorageSync(THEME_KEY);
  if (!force && cached && cached.ts && Date.now() - cached.ts < THEME_TTL && cached.storeId === (storeId || '')) {
    return Promise.resolve(cached.data);
  }
  return request({ url: '/theme', method: 'GET', data: { storeId: storeId || '' }, idempotent: true })
    .then((d) => {
      wx.setStorageSync(THEME_KEY, { ts: Date.now(), storeId: storeId || '', data: d });
      const app = getApp();
      if (app) {
        app.globalData.theme = d;
        app.globalData.themeStyle = tokensToStyle(d.tokens);
        app.globalData.themeTokens = Object.assign({}, DEFAULT_TOKENS, d.tokens);
      }
      return d;
    })
    .catch(() => {
      /* 主题拉不到不影响点单，走默认令牌 */
      const fallback = { themeId: 'default', name: '标准主题', tokens: DEFAULT_TOKENS, scope: 'DEFAULT' };
      const app = getApp();
      if (app) {
        app.globalData.theme = fallback;
        app.globalData.themeStyle = tokensToStyle(DEFAULT_TOKENS);
        app.globalData.themeTokens = DEFAULT_TOKENS;
      }
      return fallback;
    });
}

/** 页面调用：把主题令牌同步到 data.themeStyle，模板根节点 style="{{themeStyle}}" 即可 */
function applyTheme(page) {
  const app = getApp();
  const style = (app && app.globalData.themeStyle) || tokensToStyle(DEFAULT_TOKENS);
  const tokens = (app && app.globalData.themeTokens) || DEFAULT_TOKENS;
  page.setData({ themeStyle: style, themeTokens: tokens, themeName: (app && app.globalData.theme && app.globalData.theme.name) || '' });
  /* 顶部导航条颜色跟随主题 */
  if (tokens.navBg && wx.setNavigationBarColor) {
    wx.setNavigationBarColor({
      frontColor: tokens.navText === '#FFFFFF' ? '#ffffff' : '#000000',
      backgroundColor: tokens.navBg,
      fail: () => {},
    });
  }
}

/* ============================ 领券中心 ============================ */
function couponCenter(storeId) {
  return request({ url: '/coupons/center', method: 'GET', data: { storeId: storeId || '' }, idempotent: true });
}

/**
 * 领券
 * 不标记 idempotent：网络层重试会让「其实已领成功但响应丢失」的请求再领一次，
 * 第二次会命中每人/每日限领而报「已领完」，给用户错误的反馈。
 * 领券失败让用户自己再点一次，比自动重试产生误导更可控。
 */
function receiveCoupon(couponId, storeId) {
  return request({ url: '/coupons/' + couponId + '/receive', method: 'POST', data: { storeId: storeId || '' } });
}

function myCoupons(status, opts) {
  opts = opts || {};
  const data = { status: status || 'UNUSED' };
  if (opts.withContext) {
    data.withContext = 1;
    data.storeId = opts.storeId || '';
    data.goodsAmount = opts.goodsAmount || 0;
    data.soupFee = opts.soupFee || 0;
  }
  return request({ url: '/user/coupons', method: 'GET', data, idempotent: true });
}

function usableCoupons(payload) {
  return request({ url: '/coupons/usable', method: 'POST', idempotent: true, data: payload });
}

/* ============================ 团购券核销 ============================ */
/** 顾客在小程序端自助核销美团团购券 */
function verifyVoucher(code, storeId) {
  return request({
    url: '/voucher/verify',
    method: 'POST',
    idempotent: true, // 带唯一键兜底，重试不会重复核销
    data: { code: code, storeId: storeId },
  });
}

function myVouchers() {
  return request({ url: '/voucher/mine', method: 'GET', idempotent: true });
}

module.exports = {
  DEFAULT_TOKENS,
  /* 定位与门店 */
  getLocation,
  cachedLocation,
  openLocationSetting,
  nearbyStores,
  storeDetail,
  currentStore,
  setCurrentStore,
  navigateTo,
  /* 主题 */
  tokensToStyle,
  loadTheme,
  applyTheme,
  /* 券 */
  couponCenter,
  receiveCoupon,
  myCoupons,
  usableCoupons,
  /* 团购券 */
  verifyVoucher,
  myVouchers,
};
