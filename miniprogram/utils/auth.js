/**
 * 登录与用户体系
 *
 * 线上链路（USE_MOCK=false）：
 *   wx.login() -> code
 *     -> POST /auth/wechat-login { code, scene }
 *     -> 服务端 code2session 换 openid/session_key，签发 JWT（access 7 天 + refresh 30 天）
 *     -> 客户端 setToken(access_token)
 *
 * 静默登录：首次进入小程序就调用，用户无感知，只拿 openid 建档（下单不需要授权任何隐私接口）。
 * 头像昵称：在「我的」页由用户主动填写（chooseAvatar + nickname input），头像压缩后 base64 上传。
 * 手机号：需企业主体 + 已开通「手机号快速验证」。
 */
const config = require('./config');
const { request, setToken, clearToken, getToken } = require('./request');

const USER_KEY = 'lbz_user';
const USER_KEY_TTL = 30 * 24 * 3600 * 1000;
const REFRESH_KEY = 'lbz_refresh_token';

/** 包装 wx.login 为 Promise */
function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      timeout: 8000,
      success: (res) => (res.code ? resolve(res.code) : reject(new Error('wx.login 无 code'))),
      fail: (err) => reject(err),
    });
  });
}

function localUser() {
  const cached = wx.getStorageSync(USER_KEY);
  if (cached && cached.ts && Date.now() - cached.ts < USER_KEY_TTL) return cached.user;
  return null;
}

function saveUser(user) {
  wx.setStorageSync(USER_KEY, { user, ts: Date.now() });
}

/**
 * 静默登录；本地已有 token 且未强制刷新时直接复用
 * @param {boolean} force 强制重新登录
 */
function silentLogin(force) {
  if (!force) {
    const cached = localUser();
    if (cached && getToken()) return Promise.resolve(cached);
  }

  if (config.USE_MOCK) {
    const user = {
      id: 0,
      openid: 'mock_openid_' + (wx.getStorageSync('lbz_mock_openid') || seedOpenid()),
      unionid: '',
      nickname: '串串香食客',
      avatar: '',
      phoneMask: '',
      memberLevel: 1,
      memberName: '铜签会员',
      points: 120,
      registerAt: Date.now(),
    };
    setToken('mock_token_' + Date.now());
    saveUser(user);
    return Promise.resolve(user);
  }

  return wxLogin().then((code) =>
    request({
      url: '/auth/wechat-login',
      method: 'POST',
      noAuth: true,
      idempotent: true,
      data: { code, scene: 'miniapp' },
    }).then((data) => {
      setToken(data.access_token);
      if (data.refresh_token) wx.setStorageSync(REFRESH_KEY, data.refresh_token);
      const user = data.user || {};
      saveUser(user);
      return user;
    })
  );
}

function seedOpenid() {
  const id = 'seed_' + Math.random().toString(36).slice(2, 10);
  wx.setStorageSync('lbz_mock_openid', id);
  return id;
}

/** 用 refresh_token 换新 access_token（access 过期但 refresh 未过期时用户无感） */
function refreshToken() {
  const rt = wx.getStorageSync(REFRESH_KEY);
  if (!rt) return Promise.reject(new Error('无 refresh_token'));
  return request({ url: '/auth/refresh', method: 'POST', noAuth: true, data: { refresh_token: rt } }).then((data) => {
    setToken(data.access_token);
    saveUser(data.user || {});
    return data.user;
  });
}

/**
 * 更新头像昵称与个人资料
 * @param {{avatar?:string, nickname?:string, gender?:number, birthday?:string, city?:string}} payload
 */
function updateProfile(payload) {
  if (config.USE_MOCK) {
    const user = Object.assign({}, localUser() || {}, payload);
    saveUser(user);
    return Promise.resolve(user);
  }
  const body = {};
  if (payload.nickname) body.nickname = payload.nickname;
  /* gender 的 0（保密）是合法值，不能用真值判断筛掉 */
  if (payload.gender !== undefined && payload.gender !== null && payload.gender !== '') body.gender = Number(payload.gender);
  if (payload.birthday) body.birthday = payload.birthday;
  if (payload.city) body.city = payload.city;

  const uploadThenSave = payload.avatar
    ? uploadAvatar(payload.avatar).then((url) => {
        if (url) body.avatar = url;
      })
    : Promise.resolve();

  return uploadThenSave
    .then(() => {
      if (!Object.keys(body).length) return localUser() || {};
      return request({ url: '/user/profile', method: 'PUT', data: body });
    })
    .then((user) => {
      const merged = Object.assign({}, localUser() || {}, user);
      saveUser(merged);
      return merged;
    });
}

/**
 * 头像上传：先压缩再转 base64，服务端落盘后返回可访问 URL
 * 用 base64 而不是 multipart，是为了避开小程序端 multipart 的编码坑（少一个依赖、少一类线上问题）
 */
function uploadAvatar(filePath) {
  const compress = () =>
    new Promise((resolve) => {
      if (!wx.compressImage) return resolve(filePath);
      wx.compressImage({
        src: filePath,
        quality: 60,
        success: (r) => resolve(r.tempFilePath || filePath),
        fail: () => resolve(filePath),
      });
    });

  return compress().then(
    (src) =>
      new Promise((resolve, reject) => {
        wx.getFileSystemManager().readFile({
          filePath: src,
          encoding: 'base64',
          success: (r) => {
            const m = String(src).match(/\.(\w+)$/);
            request({
              url: '/user/avatar',
              method: 'POST',
              data: { base64: r.data, ext: m ? m[1].toLowerCase() : 'jpg' },
              timeout: 20000,
            }).then(
              (res) => resolve(res && res.url),
              (e) => reject(e)
            );
          },
          fail: (e) => reject(e),
        });
      })
  );
}

/** 绑定手机号（getPhoneNumber 回调后调用） */
function bindPhone(detail) {
  if (config.USE_MOCK) return Promise.resolve({ phoneMask: '138****0000' });
  return request({
    url: '/user/phone',
    method: 'POST',
    data: { encryptedData: detail.encryptedData, iv: detail.iv, code: detail.code },
  }).then((r) => {
    const user = Object.assign({}, localUser() || {}, { phoneMask: r.phoneMask });
    saveUser(user);
    return r;
  });
}

/** 用户统计（订单数/券数/积分） */
function fetchStats() {
  if (config.USE_MOCK) {
    return Promise.resolve({ orderCount: 0, ongoingCount: 0, couponCount: 3, points: 120, memberName: '铜签会员' });
  }
  return request({ url: '/user/stats', method: 'GET' });
}

/** 我的优惠券 */
function fetchCoupons(status) {
  if (config.USE_MOCK) {
    const mockCoupon = require('../mock/coupon');
    return Promise.resolve(mockCoupon.COUPONS.map((c) => Object.assign({}, c, { usable: true })));
  }
  return request({ url: '/user/coupons', method: 'GET', data: { status: status || 'UNUSED' } });
}

/** 校验登录态：进入需登录页面时调用 */
function checkSession() {
  return new Promise((resolve) => {
    wx.checkSession({
      success: () => resolve(true),
      fail: () =>
        silentLogin(true).then(
          () => resolve(true),
          () => resolve(false)
        ),
    });
  });
}

function logout() {
  if (!config.USE_MOCK) {
    request({ url: '/auth/logout', method: 'POST' }).catch(() => {});
  }
  clearToken();
  wx.removeStorageSync(USER_KEY);
  wx.removeStorageSync(REFRESH_KEY);
}

module.exports = {
  ensureLogin: silentLogin,
  silentLogin,
  refreshToken,
  updateProfile,
  bindPhone,
  fetchStats,
  fetchCoupons,
  checkSession,
  logout,
  localUser,
};
