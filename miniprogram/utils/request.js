/**
 * 统一网络层（交付级）
 *   · 自动带 token（Authorization: Bearer xxx）
 *   · 401 → 静默重登 → 重放原请求（全局去重，同一时刻只重登一次）
 *   · 幂等请求失败自动重试（默认 1 次，指数退避）；非幂等请求绝不自动重试
 *   · 并发去重：同一 URL+参数在飞行中复用同一个 Promise
 *   · 统一错误结构 { code, message, detail, requestId, biz }
 *   · 离线时快速失败并给出可读提示，不让页面白等
 */
const config = require('./config');

const TOKEN_KEY = 'lbz_token';

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || '';
}
function setToken(token) {
  wx.setStorageSync(TOKEN_KEY, token || '');
}
function clearToken() {
  wx.removeStorageSync(TOKEN_KEY);
}

/** 网络状态由 app.js 维护，避免每次请求都同步调 wx.getNetworkType */
let networkOnline = true;
function setNetworkOnline(v) {
  networkOnline = !!v;
}

function buildError(msg, code, extra) {
  return Object.assign({ code: code, message: msg }, extra || {});
}

/** 底层请求（不含 401 重登与重试） */
function raw(options) {
  return new Promise((resolve, reject) => {
    if (!networkOnline && !options.force) {
      reject(buildError('当前网络不可用，请检查网络后重试', -2, { offline: true }));
      return;
    }
    const header = Object.assign(
      {
        'Content-Type': 'application/json',
        'X-Client-Version': config.VERSION,
        'X-Env': config.ENV,
      },
      options.header || {}
    );
    const token = getToken();
    if (token && !options.noAuth) header.Authorization = 'Bearer ' + token;

    wx.request({
      url: config.BASE_URL + options.url,
      method: options.method || 'GET',
      data: options.data || {},
      header,
      timeout: options.timeout || config.TIMEOUT,
      success(res) {
        const statusCode = res.statusCode;
        const body = res.data || {};
        const requestId = (res.header && (res.header['X-Request-Id'] || res.header['x-request-id'])) || '';

        if (statusCode >= 200 && statusCode < 300) {
          if (body && typeof body.code !== 'undefined' && body.code !== 0) {
            reject(
              buildError(body.message || '操作失败', body.code, { detail: body.detail, requestId, biz: true })
            );
            return;
          }
          resolve({ data: body && typeof body.data !== 'undefined' ? body.data : body, requestId });
          return;
        }
        if (statusCode === 401) {
          clearToken();
          reject(buildError(body.message || '登录态已过期', 401, { requestId }));
          return;
        }
        if (statusCode === 429) {
          reject(buildError(body.message || '操作太频繁，请稍后重试', 42900, { requestId }));
          return;
        }
        if (statusCode === 503) {
          reject(buildError(body.message || '服务繁忙，请稍后重试', 50300, { requestId }));
          return;
        }
        reject(buildError(body.message || '请求失败(' + statusCode + ')', statusCode, { detail: body, requestId }));
      },
      fail(err) {
        const msg = String((err && err.errMsg) || '');
        if (msg.indexOf('timeout') > -1) {
          reject(buildError('网络较慢，请求超时，请重试', -1, { timeout: true }));
        } else {
          reject(buildError('网络异常，请检查网络后重试', -1, { detail: err }));
        }
      },
    });
  });
}

/* ------------------------------ 401 重登（全局去重） ------------------------------ */
let refreshTask = null;

function reLogin() {
  if (!refreshTask) {
    const auth = require('./auth');
    refreshTask = auth
      .silentLogin(true)
      .then((user) => {
        refreshTask = null;
        return user;
      })
      .catch((err) => {
        refreshTask = null;
        throw err;
      });
  }
  return refreshTask;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 业务请求 */
function request(options) {
  if (config.USE_MOCK) {
    return Promise.reject(buildError('[MOCK] ' + options.url + ' 未接入真实后端', 0));
  }
  const idempotent = (options.method || 'GET') === 'GET' || options.idempotent === true;
  const maxRetry = idempotent ? (options.retry === undefined ? config.RETRY : options.retry) : 0;

  const run = (opts, n) =>
    raw(opts).then(
      (r) => r.data,
      (err) => {
        /* 401：重登后重放一次 */
        if (err && err.code === 401 && !opts.__retried) {
          return reLogin().then(() => run(Object.assign({}, opts, { __retried: true }), 0));
        }
        /* 幂等请求：网络层错误（非业务错误）可退避重试 */
        if (n < maxRetry && err && !err.biz && !err.offline) {
          return sleep(200 * (n + 1)).then(() => run(opts, n + 1));
        }
        throw err;
      }
    );

  return run(options, 0);
}

/** 并发去重：同一请求在飞行中复用同一个 Promise */
const inflight = {};

function requestOnce(options) {
  const key = (options.method || 'GET') + ' ' + options.url + JSON.stringify(options.data || {});
  if (inflight[key]) return inflight[key];
  const p = request(options).then(
    (r) => {
      delete inflight[key];
      return r;
    },
    (e) => {
      delete inflight[key];
      throw e;
    }
  );
  inflight[key] = p;
  return p;
}

/** 全局错误提示（页面不必各自写 toast） */
function toastError(err, fallback) {
  const msg = (err && err.message) || fallback || '操作失败，请稍后重试';
  wx.showToast({ title: msg, icon: 'none', duration: 2200 });
}

module.exports = {
  request,
  requestOnce,
  raw,
  getToken,
  setToken,
  clearToken,
  setNetworkOnline,
  toastError,
};
