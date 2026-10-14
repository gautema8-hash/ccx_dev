/* ============================================================
   构建「点单小程序预览版」单文件 HTML
   ------------------------------------------------------------
   把小程序里的业务模块（utils / services / mock）内联进 HTML，
   配合 wx / getApp 的浏览器桩，让预览页面直接跑真实业务代码。
   用法：node tools/build-preview.js
   ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');
const PREVIEW = path.join(ROOT, 'preview');
const OUT = path.join(ROOT, '老北京麻辣串串香-点单小程序预览.html');

/** 需要内联的小程序模块（顺序无关，按需加载） */
const MODULES = [
  'mock/menu.js',
  'mock/coupon.js',
  'utils/config.js',
  'utils/util.js',
  'utils/request.js',
  'utils/auth.js',
  'utils/cart.js',
  'services/menu.js',
  'services/order.js',
];

function buildModuleRegistry() {
  const entries = MODULES.map((rel) => {
    const abs = path.join(MP, rel);
    if (!fs.existsSync(abs)) throw new Error('模块不存在: ' + rel);
    let src = fs.readFileSync(abs, 'utf8');
    /**
     * 预览版必须跑离线数据，但小程序源码已经切到真实后端（USE_MOCK=false）。
     * 这里只在构建产物里把开关改回 true，源码本身不动 —— 所以预览版永远与源码同步。
     */
    if (rel === 'utils/config.js') {
      src = src
        .replace(/USE_MOCK:\s*false/, 'USE_MOCK: true   /* 预览版构建时强制离线 */')
        .replace(/MOCK_PAY:\s*false/, 'MOCK_PAY: true   /* 预览版构建时强制本地收银台 */')
        .replace(/const ENV = '\w+'/, "const ENV = 'preview'")
        .replace(
          /const ENDPOINTS = \{/,
          "const ENDPOINTS = {\n  preview: 'http://127.0.0.1:3000/miniapp/v1',"
        );
    }
    return '    ' + JSON.stringify(rel) + ': ' + JSON.stringify(src);
  });
  return '  var __SRC__ = {\n' + entries.join(',\n') + '\n  };';
}

/** 浏览器侧的 wx / getApp 桩 + 极简 CommonJS 加载器 */
const RUNTIME = (registry) => `
(function () {
  'use strict';

  /* ---------- 1) 小程序业务模块源码 ---------- */
${registry}

  /* ---------- 2) wx / getApp 浏览器桩 ---------- */
  var LS = 'lbzpv:';
  window.wx = {
    getStorageSync: function (k) {
      try { var v = localStorage.getItem(LS + k); return v == null ? '' : JSON.parse(v); }
      catch (e) { return ''; }
    },
    setStorageSync: function (k, v) {
      try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) {}
    },
    removeStorageSync: function (k) {
      try { localStorage.removeItem(LS + k); } catch (e) {}
    },
    getWindowInfo: function () { return { statusBarHeight: 20, windowWidth: 375, windowHeight: 812 }; },
    getSystemInfoSync: function () { return { statusBarHeight: 20, windowWidth: 375, windowHeight: 812 }; },
    nextTick: function (fn) { setTimeout(fn, 0); },
    onError: function () {},

    showToast: function (o) { window.__UI && window.__UI.toast((o && o.title) || ''); },
    hideToast: function () {},
    showLoading: function (o) { window.__UI && window.__UI.loading(o && o.title); },
    hideLoading: function () { window.__UI && window.__UI.loadingHide(); },
    showModal: function (o) {
      if (window.__UI) window.__UI.modal(o, o.success, o.complete);
      else { o.success && o.success({ confirm: true }); o.complete && o.complete({ confirm: true }); }
    },

    requestSubscribeMessage: function (o) { o && o.fail && o.fail({ errMsg: 'preview' }); },
    requestPayment: function (o) { o && o.fail && o.fail({ errMsg: 'requestPayment:fail' }); },
    /* 预览版没有真实微信登录，但 auth 的 USE_MOCK 分支并不使用 code 的值 */
    login: function (o) { o && o.success && o.success({ code: 'preview_code_' + Date.now() }); },
    checkSession: function (o) { o && o.success && o.success({}); },
    vibrateShort: function () {},
    setTabBarBadge: function () {},
    removeTabBarBadge: function () {},
    makePhoneCall: function () { window.__UI && window.__UI.toast('已模拟拨号 010-8888 6666'); },
    openLocation: function () { window.__UI && window.__UI.toast('已模拟打开地图：东直门内大街 188 号'); },
    setClipboardData: function (o) {
      try { navigator.clipboard.writeText(o.data); } catch (e) {}
      o && o.success && o.success({});
    },
    uploadFile: function (o) { o && o.fail && o.fail({ errMsg: 'preview' }); },
    env: { USER_DATA_PATH: '/preview' },
    /* 预览版没有文件系统：让 auth.updateProfile 回落到「原样使用 dataURL」分支 */
    getFileSystemManager: function () {
      return { copyFileSync: function () { throw new Error('preview: no fs'); } };
    },
  };

  var __app__ = {
    globalData: {
      userInfo: null,
      shop: null,
      menuCache: null,
      systemInfo: null,
      statusBarHeight: 20,
      launchTs: Date.now(),
    },
  };
  window.getApp = function () { return __app__; };

  /* ---------- 3) 极简 CommonJS 加载器 ---------- */
  var cache = {};

  function dirname(p) {
    var i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }

  function resolve(from, spec) {
    if (spec.charAt(0) !== '.') return spec;
    var parts = dirname(from).split('/').filter(Boolean);
    spec.split('/').forEach(function (seg) {
      if (seg === '.' || seg === '') return;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    });
    var p = parts.join('/');
    if (!/\\.js$/.test(p)) p += '.js';
    return p;
  }

  function load(key) {
    if (cache[key]) return cache[key].exports;
    var src = __SRC__[key];
    if (src == null) throw new Error('[preview] 模块未内联: ' + key);
    var mod = { exports: {} };
    cache[key] = mod;
    var localRequire = function (spec) { return load(resolve(key, spec)); };
    var fn = new Function(
      'require', 'module', 'exports', '__filename', '__dirname',
      src + '\\n//# sourceURL=' + key
    );
    fn(localRequire, mod, mod.exports, key, dirname(key));
    return mod.exports;
  }

  window.__require = function (spec) { return load(resolve('', spec)); };
  window.__MODULE_LIST__ = Object.keys(__SRC__);
})();
`;

/* ---------------------------------------------------------- 组装 */
const css = fs.readFileSync(path.join(PREVIEW, 'preview.css'), 'utf8');
const ui = fs.readFileSync(path.join(PREVIEW, 'preview.js'), 'utf8');
const tpl = fs.readFileSync(path.join(PREVIEW, 'template.html'), 'utf8');

const registry = buildModuleRegistry();
const runtime = RUNTIME(registry);

// 用函数式替换，避免 CSS/JS 里的 $& $1 等被当成替换模式
const html = tpl
  .replace('/*__CSS__*/', () => css)
  .replace('/*__MODULES__*/', () => runtime)
  .replace('/*__UI__*/', () => ui);

fs.writeFileSync(OUT, html, 'utf8');

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('内联模块 (' + MODULES.length + '):');
MODULES.forEach((m) => {
  console.log('  · ' + m.padEnd(22) + kb(fs.statSync(path.join(MP, m)).size));
});
console.log('---');
console.log('preview.css       ' + kb(Buffer.byteLength(css)));
console.log('preview.js        ' + kb(Buffer.byteLength(ui)));
console.log('runtime + loader  ' + kb(Buffer.byteLength(runtime)));
console.log('---');
console.log('输出: ' + path.relative(ROOT, OUT) + '   (' + kb(Buffer.byteLength(html)) + ')');
