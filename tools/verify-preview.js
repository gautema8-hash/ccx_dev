/* 临时校验：把生成的单文件预览里的运行时抽出来在 Node 里跑，验证内联模块与 wx 桩 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, '老北京麻辣串串香-点单小程序预览.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

let pass = 0;
const fails = [];
const eq = (label, a, b) => {
  if (a === b) {
    pass++;
    console.log('  ok   ' + label + ' = ' + a);
  } else {
    fails.push(label + ' got=' + a + ' want=' + b);
    console.log('  FAIL ' + label + ' got=' + a + ' want=' + b);
  }
};
const truthy = (label, v) => {
  if (v) {
    pass++;
    console.log('  ok   ' + label);
  } else {
    fails.push(label + ' falsy');
    console.log('  FAIL ' + label);
  }
};

/* ---------- 1) 抽出 script 块 ---------- */
const scripts = [];
const re = /<script>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html))) scripts.push(m[1]);
eq('script 块数量', scripts.length, 2);

const runtime = scripts[0];
const uiSrc = scripts[1];

/* ---------- 2) 浏览器桩：window / localStorage ---------- */
const store = {};
const win = {};
win.window = win;
win.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => {
    store[k] = String(v);
  },
  removeItem: (k) => {
    delete store[k];
  },
};
win.navigator = { clipboard: { writeText: () => {} } };
win.setTimeout = setTimeout;
win.clearTimeout = clearTimeout;
win.requestAnimationFrame = (fn) => setTimeout(fn, 0);
win.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener: () => {},
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} } }),
};
const ctx = vm.createContext(win);
ctx.console = console;

console.log('\n[1] 运行时（wx 桩 + CommonJS 加载器）');
truthy('runtime 语法正确', (() => {
  try {
    new vm.Script(runtime);
    return true;
  } catch (e) {
    console.log('     ' + e.message);
    return false;
  }
})());
vm.runInContext(runtime, ctx);
eq('内联模块数', win.__MODULE_LIST__.length, 9);

console.log('\n[2] 模块加载与相对路径解析');
const MENU_SVC = win.__require('services/menu.js');
const CART = win.__require('utils/cart.js');
const ORDER = win.__require('services/order.js');
const AUTH = win.__require('utils/auth.js');
const MOCK_COUPON = win.__require('mock/coupon.js');
truthy('services/menu.js 可加载', !!MENU_SVC.getMenu);
truthy('services/order.js 可加载（含 ../utils/cart 相对解析）', !!ORDER.createOrder);
truthy('utils/auth.js 可加载（含 ./request → ./auth 循环引用）', !!AUTH.ensureLogin);
eq('优惠券数量（mock/coupon.js）', MOCK_COUPON.COUPONS.length, 3);

console.log('\n[3] 菜单（services/menu.js 走 mock 分支 + 60s 缓存）');
MENU_SVC.getMenu().then((menu) => {
  eq('分类数', menu.categories.length, 6);
  eq('菜品总数', menu.totalDishes, 30);
  eq('锅底数', menu.soups.length, 4);
  eq('蘸料数', menu.dips.length, 4);
  eq('辣度档位', menu.spicyOptions.length, 4);
  eq('菜品补齐 priceText', menu.categories[0].dishes[0].priceText, '3.00');
  eq('spicy 菜品注入辣度选项', menu.categories[1].dishes[0].spicyOptions.length, 4);

  return MENU_SVC.getMenu();
}).then((menu2) => {
  truthy('二次调用命中缓存', !!win.getApp().globalData.menuCache);

  console.log('\n[4] 登录（utils/auth.js 的 USE_MOCK 分支）');
  return AUTH.ensureLogin();
}).then((user) => {
  truthy('拿到 openid', !!user.openid);
  eq('会员名', user.memberName, '铜签会员');
  truthy('token 已落 Storage', !!win.wx.getStorageSync('lbz_token'));

  console.log('\n[4b] 手机号绑定 / 更换（复用 utils/auth.js 的 mock 分支）');
  return AUTH.bindPhone({}).then((r) => {
    eq('返回脱敏手机号', r.phoneMask, '138****0000');
    const lu = AUTH.localUser() || {};
    eq('本地缓存回写 phoneMask', lu.phoneMask, '138****0000');
    eq('本地缓存回写 phoneBound（否则绑定后入口仍显示「绑定手机号」）', lu.phoneBound, true);
    eq('换绑为覆盖式更新，不丢其他用户字段', lu.nickname, '串串香食客');
  });
}).then(() => {
  console.log('\n[5] 完整下单链路（与预览页点击顺序一致）');
  const menu = win.getApp().globalData.menuCache.data;
  const d101 = menu.categories[1].dishes[0];
  const d301 = menu.categories[2].dishes.find((d) => d.name === '土豆片');
  CART.add(d101, { spicyId: 'sp3', spicyName: '特辣' }, 2);
  CART.add(d101, { spicyId: 'sp1', spicyName: '微微辣' }, 1);
  CART.add(d301, null, 3);
  CART.setSoup(menu.soups[0]);
  CART.setDiningType('dinein');
  CART.setTableNo('A03');
  const sum = CART.getSummary();
  eq('明细条数（同串不同辣度分两行）', CART.get().items.length, 3);
  eq('菜品小计(分)', sum.goodsAmount, 300 * 3 + 150 * 3);
  eq('合计(分)', sum.total, 1350 + 1200);
  eq('合计文案', sum.totalText, '25.50');
  eq('可下单', sum.canSubmit, true);

  const discount = MOCK_COUPON.calcDiscount(MOCK_COUPON.COUPONS[0], sum);
  eq('新客券抵扣(分)', discount, 500);

  return ORDER.createOrder({
    items: CART.toOrderItems(),
    soup: CART.get().soup,
    dips: [],
    diningType: 'dinein',
    tableNo: 'A03',
    peopleCount: 2,
    remark: '预览校验',
    coupon: MOCK_COUPON.COUPONS[0],
    amount: {
      goods: sum.goodsAmount,
      soupFee: sum.soupFee,
      packFee: sum.packFee,
      discount,
      pay: sum.total - discount,
    },
  });
}).then((order) => {
  eq('下单后状态', order.status, 'UNPAID');
  eq('实付(分)', order.amount.pay, 2050);
  eq('明细保留辣度', order.items[0].specText, '特辣');
  return ORDER.payOrder(order.id).then((paid) => ({ order, paid }));
}).then((r) => {
  eq('支付后状态', r.paid.status, 'PAID');
  truthy('生成取餐码', !!r.paid.pickupNo);
  // 模拟 200 秒后
  const list = win.wx.getStorageSync('lbz_orders_v1');
  list[0].payTime = Date.now() - 200 * 1000;
  win.wx.setStorageSync('lbz_orders_v1', list);
  const adv = ORDER.refreshStatus(r.order.id);
  eq('200 秒后状态', adv.status, 'READY');
  eq('时间轴已完成节点数', adv.timeline.filter((t) => t.done).length, 4);
  return ORDER.listOrders('all');
}).then((list) => {
  eq('订单列表条数', list.length, 1);
  truthy('列表卡片用 summaryText', !!list[0].summaryText);

  console.log('\n[5b] 再来一单回填购物车');
  CART.clearAll();
  eq('清空后件数', CART.getSummary().count, 0);
  return ORDER.reorder(list[0].id).then(() => list);
}).then((list) => {
  eq('回填后件数', CART.getSummary().count, 6);
  eq('回填带回锅底', CART.get().soup.name, '牛油红汤锅');
  eq('回填带回桌号', CART.get().tableNo, 'A03');

  /* ---------- 6) UI 层静态校验 ---------- */
  console.log('\n[6] 预览视图层（preview.js）静态校验');
  truthy('preview.js 语法正确', (() => {
    try {
      new vm.Script(uiSrc);
      return true;
    } catch (e) {
      console.log('     ' + e.message);
      return false;
    }
  })());
  const A_DEF = uiSrc.match(/const A = \{([\s\S]*?)\n  \};/);
  truthy('解析到 Actions 对象', !!A_DEF);
  const defined = new Set();
  // 同时捕获「方法名(」与「简写属性,」两种写法
  (A_DEF ? A_DEF[1] : '').replace(/^\s{4}([a-zA-Z_$][\w$]*)\s*[(,:]/gm, (_, n) => defined.add(n));
  const used = new Set();
  // 方法名首字符不含 $，避免把 `A.${o.act}` 里的 $ 当成方法名
  uiSrc.replace(/\bA\.([a-zA-Z_][\w$]*)/g, (_, n) => used.add(n));
  const missing = [...used].filter((n) => !defined.has(n));
  eq('A.xxx 全部有定义（缺失：' + (missing.join(',') || '无') + '）', missing.length, 0);

  const acts = new Set();
  uiSrc.replace(/act:\s*'([a-zA-Z_$][\w$]*)'/g, (_, n) => acts.add(n));
  const missAct = [...acts].filter((n) => !defined.has(n));
  eq('步进器 act 全部有定义（缺失：' + (missAct.join(',') || '无') + '）', missAct.length, 0);

  /* 「我的」页入口：「分享给好友」已按要求移除；手机号入口保留并状态化（未绑定 / 已绑定·更换） */
  truthy('「我的」页无「分享给好友」入口', uiSrc.indexOf('分享给好友') === -1);
  truthy('「我的」页含手机号入口（A.bindPhone）', uiSrc.indexOf('A.bindPhone()') !== -1);
  truthy('手机号入口状态化文案齐备（绑定 / 更换）', /绑定手机号/.test(uiSrc) && /· 更换/.test(uiSrc));

  console.log('\n========================================');
  console.log('  通过 ' + pass + ' 项 / 失败 ' + fails.length + ' 项');
  if (fails.length) fails.forEach((f) => console.log('  ! ' + f));
  console.log('========================================');
  process.exit(fails.length ? 1 : 0);
}).catch((e) => {
  console.error('CRASH', e);
  process.exit(1);
});
