/* ============================================================
   老北京麻辣串串香 · 真机模拟器端到端测试
   ------------------------------------------------------------
   前置（各做一次）：
     1) 微信开发者工具 → 设置 → 安全设置 → 服务端口 → 开启
     2) cli.bat auto --project <本工程路径> --auto-port 9420
   运行：
     node tools/e2e-automator.js

   选择器策略（实测结论）：
     · 页面级元素 —— 用 CSS（.dish__add / .cat / .dip / .tabs__item …）
     · 自定义组件内部 —— 用 XPath，且必须「精确 class token + 容器锚定」；
       若用 contains(@class,"sku-opt")，会连带命中 .sku-opts / .sku-opt__dot
     · 状态断言一律读 page.data()，不猜 DOM
     · 重置购物车必须走 UI（cart store 的 state 缓存在内存里，清 Storage 无效）
   ============================================================ */
const path = require('path');
const fs = require('fs');

module.paths.push('C:/Users/xuyan/.workbuddy/binaries/node/workspace/node_modules');
const automator = require('miniprogram-automator');

const CLI_PATH = 'D:/sofa/wxdevtools/微信web开发者工具/cli.bat';
const PROJECT_PATH = path.resolve(__dirname, '../miniprogram');
const AUTO_PORT = 9420;
/** 真实后端模式下的后端地址（小程序端 API，供 e2e 读订单数据） */
const SERVER = process.env.API_BASE || 'http://127.0.0.1:3000/miniapp/v1';
/** 管理系统后端地址：拆分后管理接口在独立服务，鉴权也由 X-Admin-Token 改为员工 Bearer 令牌 */
const ADMIN_SERVER = process.env.ADMIN_API_BASE || 'http://127.0.0.1:3001/miniapp/v1/admin';
let staffToken = null;
const adminLogin = () =>
  fetch(ADMIN_SERVER + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: 'Admin@123456' }),
  })
    .then((r) => r.json())
    .then((j) => {
      if (!j.data || !j.data.access_token) throw new Error('管理端登录失败: ' + JSON.stringify(j));
      staffToken = j.data.access_token;
      return staffToken;
    });
const adminCall = (p, body) => {
  if (!staffToken) return adminLogin().then(() => adminCall(p, body));
  return fetch(ADMIN_SERVER + p.replace(/^\/admin/, ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + staffToken },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const j = await r.json();
    if (j && j.code === 40100) {
      staffToken = null;
      await adminLogin();
      return adminCall(p, body);
    }
    return j;
  });
};

/* ---------- XPath 工具 ---------- */
const C = (cls) => `contains(concat(" ",normalize-space(@class)," ")," ${cls} ")`;
const ANY = (cls) => `//*[${C(cls)}]`;
const IN = (outer, inner) => `//*[${C(outer)}]//*[${C(inner)}]`;
const NTH = (xp, n) => `(${xp})[${n}]`;
const TXT = (t) => `//*[contains(text(),"${t}")]`;
/**
 * 精确「class + 文案」定位
 * 纯文本 XPath 太容易误命中：例如点「公司」会先命中「公司名称」这个 label，
 * 加上 class 约束才能稳定点中分段控件里的那一个。
 */
const TXC = (cls, t) => `//*[${C(cls)} and contains(text(),"${t}")]`;
/**
 * 「class 容器 + 后代文案」定位
 * 有些控件把文案包在子 <text> 里（如筛选栏 .bar__item > <text>），
 * 此时父节点自己的 text() 是空的，必须用后代匹配才点得到。
 */
const TXTIN = (cls, t) => `//*[${C(cls)}]//*[contains(text(),"${t}")]`;

/**
 * 可选：清空本轮要写入的业务数据（地址 / 客服会话 / 开票申请）
 * 让 e2e 可重复运行 —— 不清的话第二次跑「提交开票申请」会命中
 * 「该订单已提交过开票申请」的幂等保护，测试结果就不可信了。
 * 用 E2E_RESET=1 显式开启，默认不动库（避免误伤手工数据）。
 */
async function resetFixtures() {
  if (process.env.E2E_RESET !== '1') return false;
  const mysql = require(path.resolve(__dirname, '../miniprogram-server/node_modules/mysql2/promise'));
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root123!@#',
    database: process.env.DB_NAME || 'lbz_order',
  });
  for (const t of ['mp_service_message', 'mp_service_ticket', 'mp_invoice_request', 'mp_address']) {
    await c.query('DELETE FROM ' + t);
  }
  await c.end();
  return true;
}

let pass = 0;
const fails = [];
const ok = (label, extra) => {
  pass++;
  console.log('  \x1b[32m✓\x1b[0m ' + label + (extra !== undefined ? '  → ' + extra : ''));
};
const bad = (label, extra) => {
  fails.push(label + (extra !== undefined ? ' (' + extra + ')' : ''));
  console.log('  \x1b[31m✗\x1b[0m ' + label + (extra !== undefined ? '  → ' + extra : ''));
};
const eq = (label, a, b) => (a === b ? ok(label, a) : bad(label, `got=${a} want=${b}`));
const truthy = (label, v, extra) => (v ? ok(label, extra) : bad(label, 'falsy'));
const skip = (label, why) => console.log('  \x1b[33m–\x1b[0m ' + label + '  （跳过：' + why + '）');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n=== 老北京麻辣串串香 · 模拟器端到端测试 ===\n');

  let mini;
  const WS = process.env.WX_AUTO_WS || 'ws://127.0.0.1:' + AUTO_PORT;
  console.log('[0] 连接自动化会话 ' + WS + ' …');
  try {
    mini = await automator.connect({ wsEndpoint: WS, timeout: 60000 });
    ok('已连接到自动化会话', WS);
  } catch (e1) {
    console.log('    直连失败（' + ((e1 && e1.message) || e1) + '），回退到 automator.launch …');
    try {
      mini = await automator.launch({
        cliPath: CLI_PATH,
        projectPath: PROJECT_PATH,
        port: AUTO_PORT,
        timeout: 120000,
        trustProject: true,
      });
      ok('自动化连接建立', 'port=' + AUTO_PORT);
    } catch (e2) {
      console.error('\n启动失败：' + ((e2 && e2.message) || e2));
      console.error('请先执行： cli.bat auto --project ' + PROJECT_PATH + ' --auto-port ' + AUTO_PORT);
      process.exit(1);
    }
  }

  const tap = async (el) => {
    if (!el) return false;
    await el.tap();
    await sleep(650);
    return true;
  };
  const tapXp = (page, xp) => elOf(page, xp).then(tap);
  /** 注意：带下标谓词的 XPath 形如 (//*[...])[4]，开头是 "(" 而不是 "/" */
  const isXpath = (s) => s.charAt(0) === '/' || s.charAt(0) === '(';
  /**
   * 取元素（带真实性校验）
   *
   * 坑：Automator 的 getElementByXpath 在「找不到匹配」时**不返回 null**，
   * 而是返回一个假元素对象（text() 恒为 ''、wxml()/attribute() 抛错、offset 恒为 {0,0}）。
   * 直接 !!el 判断会让所有「元素存在」断言假阳性（连 ZZZZ_NOT_EXIST 都能"命中"），
   * tapXp 也会对着空气点击。真元素有 tagName，假元素 tagName === undefined，据此过滤。
   */
  const elOf = async (page, sel) => {
    try {
      const el = isXpath(sel) ? await page.getElementByXpath(sel) : await page.$(sel);
      if (!el) return null;
      if (el.tagName === undefined) return null;
      return el;
    } catch (e) {
      return null;
    }
  };
  const textOf = async (page, sel) => {
    const el = await elOf(page, sel);
    return el ? String(await el.text()).replace(/\s+/g, '') : '';
  };
  const classOf = async (page, sel) => {
    const el = await elOf(page, sel);
    if (!el) return '';
    try {
      return String(await el.attribute('class'));
    } catch (e) {
      return '';
    }
  };

  try {
    await mini.mockWxMethod('showModal', { confirm: true, cancel: false });
    await mini.mockWxMethod('vibrateShort', { errMsg: 'vibrateShort:ok' });

    /* 可选前置：清空本轮要写入的业务数据，保证脚本可重复运行 */
    if (await resetFixtures()) ok('已清理地址 / 客服 / 开票测试数据（E2E_RESET=1）');
    else skip('清理测试数据', '未设置 E2E_RESET=1，按现有数据继续（断言已改为增量比对）');

    /* ================= 0. 重置 ================= */
    console.log('[0.1] 重置：我的 → 清除本地缓存（清掉内存态购物车）');
    const mine0 = await mini.reLaunch('/pages/mine/mine');
    await mine0.waitFor(1600);
    await tapXp(mine0, TXT('清除本地缓存'));
    await sleep(800);
    ok('已重置本地状态');

    /* ============ 0.2 固定测试定位与门店 ============
       菜单页/确认页在 onLoad 会调 chain.autoPickNearestStore()：
       没有任何已选门店时，它按定位挑最近的店。模拟器定位会漂（可能落到丰台店），
       而丰台店有 2 个菜停售（totalDishes=28），会把后续「菜品数 / 价格」断言带偏。
       这里显式把定位钉在朝阳大悦城，让自动匹配**确定地**选中 st_cy（30 个菜）。
       同时清掉可能残留的已选门店，避免「有门店就不重新匹配」把固定动作短路掉。 */
    await mini.evaluate(() => {
      wx.removeStorageSync('lbz_store_v1');
      wx.setStorageSync('lbz_location_v1', { lat: 39.9245, lng: 116.516, ts: Date.now() });
      return 'ok';
    });
    ok('已固定定位 → 自动匹配应选中 st_cy（朝阳大悦城店）');

    /* ================= 1. 首屏 ================= */
    console.log('\n[1] 点单页：首屏与菜单');
    const menu = await mini.reLaunch('/pages/menu/menu');
    await menu.waitFor(1800);
    let d = await menu.data();
    eq('页面路径', menu.path, 'pages/menu/menu');
    eq('自动匹配门店 = st_cy', d.storeId, 'st_cy');
    eq('分类数', d.categories.length, 6);
    eq('菜品总数', d.totalDishes, 30);
    eq('骨架屏已关闭', d.loading, false);
    truthy('左侧高亮已就位', !!d.activeCat, d.activeCat);
    eq('锅底列表已加载', d.soups.length, 4);
    truthy('桌号已默认带出', !!d.tableNo, d.tableNo);
    eq('初始购物车为空', d.cart.count, 0);

    /* ================= 2. 分类联动 ================= */
    console.log('\n[2] 分类联动');
    const cats = await menu.$$('.cat');
    eq('左侧分类节点数', cats.length, 6);
    await tap(cats[2]);
    await sleep(500);
    d = await menu.data();
    eq('高亮切到第 3 个分类', d.activeCat, d.categories[2].id);
    eq('scroll-into-view 已复位（480ms 后）', d.dishScrollInto, '');
    await tap(cats[0]);
    await sleep(500);

    /* ================= 3. 规格弹层 ================= */
    console.log('\n[3] 选串加购：辣度弹层（特辣 ×2）');
    const spicyDish = (function find(list) {
      for (const c of list) {
        const h = c.dishes.find((x) => x.spicy);
        if (h) return h;
      }
      return null;
    })(d.categories);
    truthy('定位到带辣度的菜品', !!spicyDish, spicyDish && spicyDish.name);
    /* 「+」按钮现在覆盖全部在售菜品：19 个辣度菜 + 10 个无规格菜（数量为 0 时显示「+」） */
    eq('列表加号数（每道在售菜都有加号）', (await menu.$$('.dish__add')).length, d.totalDishes);

    await tap(await menu.$('.dish__add'));
    d = await menu.data();
    eq('弹层已打开', d.skuShow, true);
    eq('弹层菜品正确', d.skuDish && d.skuDish.name, spicyDish.name);

    // 读出四档辣度的文案与选中态（用 page.data() 读不到组件内部状态，这里读真实 DOM）
    const optTexts = [];
    const optClasses = [];
    for (let i = 1; i <= 4; i++) {
      const xp = NTH(IN('sku-opts', 'sku-opt'), i);
      optTexts.push(await textOf(menu, xp));
      optClasses.push(await classOf(menu, xp));
    }
    eq('辣度四档文案', optTexts.join('/'), '不辣/微微辣/中辣/特辣');
    eq('默认选中第 2 档（微微辣）', optClasses[1].indexOf('is-on') > -1, true);
    eq('其余档未选中', optClasses.filter((c) => c.indexOf('is-on') > -1).length, 1);

    await tap(await elOf(menu, NTH(IN('sku-opts', 'sku-opt'), 4))); // 特辣
    await tapXp(menu, IN('sku-qty', 'stepper__plus')); // 1 → 2
    eq('弹层数量显示为 2', await textOf(menu, IN('sku-qty', 'stepper__num')), '2');
    await tapXp(menu, ANY('sku-foot__btn'));
    await sleep(600);

    d = await menu.data();
    eq('弹层已关闭', d.skuShow, false);
    eq('购物车件数 = 2', d.cart.count, 2);
    eq('明细条数 = 1', d.cart.kinds, 1);
    eq('菜品小计 = 6.00（¥3 × 2）', d.cart.goodsText, '6.00');
    eq('锅底费 = 12.00（默认牛油红汤）', d.cart.soupFeeText, '12.00');
    eq('合计 = 18.00', d.cart.totalText, '18.00');

    console.log('\n[4] 同串不同辣度 → 必须分成两条明细');
    await tap(await menu.$('.dish__add'));
    await sleep(400);
    eq(
      '弹层带出上次选的辣度（特辣）',
      (await classOf(menu, NTH(IN('sku-opts', 'sku-opt'), 4))).indexOf('is-on') > -1,
      true
    );
    await tapXp(menu, NTH(IN('sku-opts', 'sku-opt'), 1)); // 不辣
    await tapXp(menu, ANY('sku-foot__btn'));
    await sleep(600);
    d = await menu.data();
    eq('明细条数 = 2（同款两行）', d.cart.kinds, 2);
    eq('件数 = 3', d.cart.count, 3);
    eq('菜品小计 = 9.00', d.cart.goodsText, '9.00');

    skip('无规格菜品（土豆片类）列表内步进器', 'DevTools 对自定义组件内元素的坐标解析不可靠，点击不生效');

    /* ================= 5. 购物车 ================= */
    console.log('\n[5] 购物车：锅底 / 蘸料 / 金额');
    await mini.reLaunch('/pages/cart/cart');
    await sleep(1500);
    const cartPage = await mini.currentPage();
    eq('当前页', cartPage.path, 'pages/cart/cart');
    d = await cartPage.data();
    eq('明细行数', d.items.length, 2);
    eq('件数', d.count, 3);
    truthy('锅底已自动选中', !!d.soupId, d.soupName);
    truthy('满足下单条件', d.summary.canSubmit);
    eq('合计 = 21.00（9 + 12）', d.summary.totalText, '21.00');

    const dips = await cartPage.$$('.dip');
    eq('蘸料可选项', dips.length, 4);
    await tap(dips[0]);
    eq('已勾选 1 项蘸料', Object.keys((await cartPage.data()).dipChecked).length, 1);

    const soups = await cartPage.$$('.soup');
    eq('锅底卡片数', soups.length, 4);
    await tap(soups[2]); // 鸳鸯锅 ¥18
    await sleep(500);
    eq('锅底费更新为 18.00', (await cartPage.data()).summary.soupFeeText, '18.00');
    eq('合计随之变 27.00', (await cartPage.data()).summary.totalText, '27.00');

    /* ================= 6. 结算 + 优惠券 ================= */
    console.log('\n[6] 结算与优惠券（分包页）');
    await tap(await cartPage.$('.action-bar .btn-primary'));
    await sleep(1400);
    const confirmPage = await mini.currentPage();
    eq('进入确认订单页', confirmPage.path, 'pages/confirm/confirm');
    /* recalc() 是异步的（真实后端走 POST /coupons/usable），轮询等待金额算完，避免读到初始 '0.00' */
    let cd = await confirmPage.data();
    for (let i = 0; i < 20 && (cd.payText === '0.00' || cd.usableCount === 0); i++) {
      await sleep(300);
      cd = await confirmPage.data();
    }
    eq('明细已带过来', cd.items.length, 2);
    eq('应付 = 27.00（未选券）', cd.payText, '27.00');
    eq('未选券时无抵扣', cd.discount, 0);
    /* 真实后端新客只自动发 1 张「新客立减券」（seed 的 cp1），非 mock 时代的 3 张 */
    eq('可用券数量', cd.usableCount, 1);

    await tap(await confirmPage.$('#coupon-row'));
    await sleep(1400);
    const couponPage = await mini.currentPage();
    eq('跳到分包优惠券页', couponPage.path, 'packageUser/pages/coupon/coupon');
    eq('券列表条数', (await couponPage.$$('.coupon')).length, 1);
    await tap(await couponPage.$('.coupon')); // 选第一张 → 自动返回
    /* 选券回传（globalData + navigateBack）偶发慢于 1.4s，轮询等返回而不是死等 */
    for (let i = 0; i < 15; i++) {
      const cur = await mini.currentPage();
      if (cur.path === 'pages/confirm/confirm') break;
      await sleep(300);
    }

    eq('自动返回结算页', (await mini.currentPage()).path, 'pages/confirm/confirm');
    cd = await (await mini.currentPage()).data();
    truthy('优惠券已选中', !!cd.coupon, cd.coupon && cd.coupon.name);
    eq('抵扣 5.00', cd.discountText, '5.00');
    eq('实付 = 22.00', cd.payText, '22.00');

    /* ================= 7. 支付 ================= */
    console.log('\n[7] 提交订单 + 支付（showModal 已 mock 为自动确认）');
    const payBefore = cd.payText;
    await tap(await (await mini.currentPage()).$('.action-bar .btn-primary'));
    await sleep(3500);

    /* ================= 8. 订单详情 ================= */
    console.log('\n[8] 订单详情');
    const detail = await mini.currentPage();
    eq('跳到订单详情', detail.path, 'pages/order-detail/order-detail');
    let od = await detail.data();
    truthy('订单已加载', !!od.order);
    eq('支付后状态', od.order.status, 'PAID');
    eq('展示取餐码/桌号', od.showPickup, true);
    eq('时间轴节点数', od.order.timeline.length, 5);
    eq('实付与结算页一致', od.order.amount.payText, payBefore);
    truthy('轮询已启动', od.polling);

    const cartAfter = await mini.evaluate(() => {
      const c = wx.getStorageSync('lbz_cart_v1') || {};
      return { items: (c.items || []).length, hasSoup: !!c.soup, dips: (c.dips || []).length };
    });
    eq('支付后购物车菜品已清空', cartAfter.items, 0);
    eq('锅底被保留（便于再来一单）', cartAfter.hasSoup, true);
    eq('蘸料被保留', cartAfter.dips, 1);

    console.log('\n[9] 状态自动推进（通过商家端接口：接单 → 制作 → 出餐）');
    for (const act of ['accept', 'cook', 'ready']) {
      const r = await adminCall('/admin/orders/' + od.order.id + '/' + act);
      if (r.code !== 0) bad('商家流转 ' + act, r.message);
    }
    ok('已推进到 READY');
    await detail.waitFor(6500); // 等一次 5s 轮询
    od = await detail.data();
    eq('状态推进到 READY', od.order.status, 'READY');
    eq('已完成时间轴节点数', od.order.timeline.filter((t) => t.done).length, 4);
    eq('轮询仍在进行', od.polling, true);

    /* ================= 10. 订单列表 ================= */
    console.log('\n[10] 订单列表：筛选与「进行中」角标（本次修复项）');
    await mini.reLaunch('/pages/orders/orders');
    await sleep(1700);
    const ordersPage = await mini.currentPage();
    d = await ordersPage.data();
    eq('订单数', d.orders.length, 1);
    eq('「进行中」角标', d.counts.ongoing, 1);
    truthy('卡片摘要文案', !!d.orders[0].summaryText, d.orders[0].summaryText);
    eq('卡片金额', d.orders[0].amount.payText, payBefore);

    const tabs = await ordersPage.$$('.tabs__item');
    eq('筛选页签数', tabs.length, 3);
    await tap(tabs[2]);
    await sleep(1200);
    eq('「已完成」筛选结果', (await ordersPage.data()).orders.length, 0);
    await tap(tabs[1]);
    await sleep(1200);
    eq('「进行中」筛选结果', (await ordersPage.data()).orders.length, 1);
    await tap(tabs[0]);
    await sleep(1200);

    /* ================= 11. 再来一单 ================= */
    console.log('\n[11] 再来一单：明细回填购物车');
    await adminCall('/admin/orders/' + od.order.id + '/done');
    await mini.reLaunch('/pages/menu/menu');
    await sleep(700);
    await mini.reLaunch('/pages/orders/orders');
    await sleep(1700);
    const ordersPage2 = await mini.currentPage();
    const reorderBtn = await ordersPage2.$('.order__actions .btn-ghost');
    truthy('找到「再来一单」按钮', !!reorderBtn);
    await tap(reorderBtn);
    await sleep(1600);
    const back = await mini.evaluate(() => {
      const c = wx.getStorageSync('lbz_cart_v1') || {};
      return {
        rows: (c.items || []).length,
        count: (c.items || []).reduce((s, i) => s + i.count, 0),
        soup: c.soup ? c.soup.name : '',
      };
    });
    eq('回填明细行数', back.rows, 2);
    eq('回填件数', back.count, 3);
    truthy('连同锅底一起回填', !!back.soup, back.soup);

    /* ================= 12. 我的 ================= */
    console.log('\n[12] 我的页：用户体系与统计');
    await mini.reLaunch('/pages/mine/mine');
    await sleep(1600);
    const md = await (await mini.currentPage()).data();
    eq('订单总数已统计', md.stats.orderCount, 1);
    /* 真实后端新客只发 1 张「新客立减券」，本流程中用掉 1 张 → 剩 0 张 */
    eq('未使用优惠券数量（1 张新客券用掉后为 0）', md.stats.couponCount, 0);
    eq('积分随完成订单到账', md.stats.points, 22);
    truthy('已拿到用户信息', !!md.user.openid, md.user.nickname);

    /* 用户卡展示态：头像与名字必须由 syncProfile 正确派生，任何状态都不能空白 */
    eq('已识别为登录态', md.isLogin, true);
    truthy('名字有兜底文案（不会空白）', !!md.displayName, md.displayName);
    truthy('头像占位文字有兜底', !!md.avatarText, md.avatarText);
    eq('无改动时不显示「保存」高亮', md.hasPending, false);
    /* ================= 13. 我的：三个分组的新增入口 ================= */
    console.log('\n[13] 我的页：分组入口与新增功能可达性');
    await mini.reLaunch('/pages/mine/mine');
    await sleep(1500);
    const minePage = await mini.currentPage();
    for (const g of ['交易与资产', '门店与服务', '账户与设置']) {
      truthy('分组标题：' + g, !!(await elOf(minePage, TXT(g))));
    }
    for (const item of ['发票管理', '收货地址', '在线客服', '加盟咨询', '个人资料', '账号设置', '协议及政策', '选择门店']) {
      truthy('入口存在：' + item, !!(await elOf(minePage, TXT(item))));
    }
    const mineData = await minePage.data();
    truthy('发票入口副文案有值', !!mineData.invoiceTip, mineData.invoiceTip);
    truthy('地址入口副文案有值', !!mineData.addressTip, mineData.addressTip);
    /* 旧的「发票抬头」二级 ActionSheet 已下线，抬头管理改为发票管理内的独立页 */
    eq('旧「发票抬头」入口已移除', !!(await elOf(minePage, TXT('发票抬头'))), false);

    /* ================= 14. 收货地址：新增 / 设为默认 / 删除 ================= */
    console.log('\n[14] 收货地址：新增（含校验）→ 编辑 → 设为默认');
    const addrPage = await mini.navigateTo('/packageUser/pages/address/address');
    await sleep(1600);
    eq('跳转到地址管理', addrPage.path, 'packageUser/pages/address/address');
    const addr0 = await addrPage.data();
    const addrBefore = addr0.list.length;
    if (!addrBefore) truthy('空态给出新增引导', !!(await elOf(addrPage, TXT('添加地址后'))));
    else skip('空态新增引导', '库里已有地址数据（未加 E2E_RESET=1）');

    const editPage = await mini.navigateTo('/packageUser/pages/address-edit/address-edit');
    await sleep(1200);
    eq('跳转到新增地址', editPage.path, 'packageUser/pages/address-edit/address-edit');
    /* 只填一个字 → 保存必须被客户端校验拦下（不依赖服务端报错） */
    await (await editPage.$$('.form__input'))[0].input('张');
    await tapXp(editPage, TXC('btn-primary', '保存地址'));
    await sleep(700);
    eq('姓名过短时不跳页（客户端校验生效）', (await mini.currentPage()).path, 'packageUser/pages/address-edit/address-edit');

    const eInputs = await editPage.$$('.form__input');
    await eInputs[0].input('张三');
    await eInputs[1].input('13800138000');
    await (await editPage.$('textarea')).input('东直门内大街 12 号院 3 单元 501');
    await tapXp(editPage, TXC('tags__item', '家'));
    /* 默认地址开关：原生 switch，用 tap 切换 */
    await tap(await editPage.$('switch'));
    await tapXp(editPage, TXC('btn-primary', '保存地址'));
    await sleep(2200);
    eq('保存后返回列表', (await mini.currentPage()).path, 'packageUser/pages/address/address');
    const addr1 = await addrPage.data();
    eq('地址已创建', addr1.list.length, addrBefore + 1);
    /* 服务端把默认地址置顶 */
    const top = addr1.list[0];
    truthy('手机号已脱敏展示', /^\d{3}\*{4}\d{4}$/.test(top.phoneMask), top.phoneMask);
    truthy('地区文案已拼装', !!top.regionText, top.regionText);
    eq('标签已保存', top.tag, '家');
    eq('设为默认已生效', top.isDefault, true);

    /* 编辑：改详细地址（走同一个表单页的编辑态） */
    await tapXp(addrPage, TXC('addr__act', '编辑'));
    await sleep(1400);
    const edit2 = await mini.currentPage();
    eq('进入编辑态', (await edit2.data()).isEdit, true);
    await (await edit2.$('textarea')).input('东直门内大街 12 号院 3 单元 502（改）');
    await tapXp(edit2, TXC('btn-primary', '保存地址'));
    await sleep(2200);
    truthy('详细地址已更新', (await addrPage.data()).list[0].detail.indexOf('502') > -1, (await addrPage.data()).list[0].detail);

    /* ================= 15. 在线客服：会话 / 表情 / 「+」面板 / 文本消息 ================= */
    console.log('\n[15] 在线客服：会话建立、多媒体面板与消息收发');
    const svcPage = await mini.navigateTo('/packageUser/pages/service/service');
    await sleep(2400);
    eq('跳转到在线客服', svcPage.path, 'packageUser/pages/service/service');
    const svc0 = await svcPage.data();
    truthy('会话已建立', !!svc0.ticketId, svc0.ticketId);
    truthy('已推送欢迎语', svc0.messages.length >= 1, svc0.messages.length + ' 条');
    truthy('快捷问题已下发', svc0.quickReplies.length >= 3, svc0.quickReplies.length + ' 条');
    eq('表情面板默认收起', svc0.showEmoji, false);

    await tapXp(svcPage, TXC('bar__icon', '🙂'));
    await sleep(500);
    const svcE = await svcPage.data();
    truthy('表情面板已展开', svcE.showEmoji);
    eq('表情数量', svcE.emojis.length, 32);
    await tapXp(svcPage, TXC('bar__icon', '🙂'));
    await sleep(400);

    await tapXp(svcPage, ANY('bar__icon--plus'));
    await sleep(600);
    truthy('「+」面板已展开', !!(await svcPage.data()).panel);
    for (const label of ['拍照', '相册', '视频', '文件', '录音']) {
      truthy('多媒体项存在：' + label, !!(await elOf(svcPage, TXC('panel__label', label))));
    }
    await tapXp(svcPage, ANY('bar__icon--plus'));
    await sleep(400);

    const draftInput = await svcPage.$('.bar__input');
    await draftInput.input('请问附近有停车位吗？');
    await sleep(300);
    await tapXp(svcPage, TXC('bar__send', '发送'));
    await sleep(2400);
    const svc1 = await svcPage.data();
    truthy('我的消息已进入列表', svc1.messages.some((m) => String(m.content).indexOf('停车位') > -1));
    truthy('收到客服侧回复', svc1.messages.some((m) => m.sender !== 'USER' && m.type === 'text'));
    truthy('文本气泡 ≥2 条', svc1.messages.filter((m) => m.type === 'text').length >= 2);

    /* ================= 16. 协议及政策：列表 + 富文本详情 ================= */
    console.log('\n[16] 协议及政策：列表与富文本长文');
    const agPage = await mini.navigateTo('/packageUser/pages/agreement/agreement');
    await sleep(1800);
    eq('跳转到协议列表', agPage.path, 'packageUser/pages/agreement/agreement');
    const ag0 = await agPage.data();
    eq('协议条数', ag0.list.length, 4);
    eq('协议顺序（sort 字段生效）', ag0.list.map((a) => a.code).join(','), 'invoice-notice,license-publicity,privacy-policy,user-agreement');
    truthy('每条都有版本号', ag0.list.every((a) => /^v\d/.test(a.version)));

    await tapXp(agPage, TXC('ag__title', '用户协议'));
    await sleep(1800);
    const agdPage = await mini.currentPage();
    eq('跳转到协议详情', agdPage.path, 'packageUser/pages/agreement-detail/agreement-detail');
    const agd = await agdPage.data();
    eq('标题正确', agd.ag.title, '用户协议');
    truthy('富文本正文非空', String(agd.ag.contentHtml).length > 200, String(agd.ag.contentHtml).length + ' 字符');
    truthy('正文含小标题标签', agd.ag.contentHtml.indexOf('<h3') > -1);
    truthy('富文本容器已渲染', (await agdPage.$$('.doc__rich')).length >= 1);
    await mini.navigateBack();
    await sleep(900);

    /* ================= 17. 加盟咨询：海报 / 二维码 / 保存能力 ================= */
    console.log('\n[17] 加盟咨询：宣传海报与企微二维码');
    const frPage = await mini.navigateTo('/packageUser/pages/franchise/franchise');
    await sleep(2000);
    eq('跳转到加盟咨询', frPage.path, 'packageUser/pages/franchise/franchise');
    const fr0 = await frPage.data();
    truthy('海报标题来自后台配置', !!fr0.info.title, fr0.info.title);
    eq('亮点四宫格', fr0.info.highlights.length, 4);
    truthy('企微号已配置', !!fr0.info.wecomId, fr0.info.wecomId);
    truthy('咨询电话已配置', !!fr0.info.consultPhone, fr0.info.consultPhone);
    /* 后台未配置二维码时必须渲染占位图，而不是空白块 */
    const qrImg = await elOf(frPage, '.qr__img');
    const qrPh = await elOf(frPage, '.qr__ph');
    truthy('二维码区已渲染（图片或占位图二选一）', !!qrImg || !!qrPh, qrImg ? '已配置二维码' : 'CSS 占位图');
    truthy('保存到相册入口存在', !!(await elOf(frPage, TXC('btn-primary', '保存到相册'))));
    truthy('预览海报入口存在', !!(await elOf(frPage, TXC('btn-ghost', '预览海报'))));
    truthy('离屏画布已挂载', (await frPage.$$('canvas')).length >= 1);

    /* ================= 18. 门店选择：定位排序 / 下拉筛选 / 搜索 / 门店详情 ================= */
    console.log('\n[18] 门店：距离排序、下拉筛选、关键词搜索与门店详情');
    const slPage = await mini.reLaunch('/pages/store-list/store-list');
    await slPage.waitFor(2600);
    const sl0 = await slPage.data();
    truthy('门店列表非空', sl0.stores.length >= 3, sl0.stores.length + ' 家');
    eq('筛选项默认全部生效', [sl0.type, sl0.onlyOpen, sl0.maxKm].join('|'), '|false|0');
    eq('筛选面板默认收起', sl0.panel, '');
    const dist = sl0.stores.map((s) => s.distanceKm).filter((v) => typeof v === 'number');
    if (dist.length === sl0.stores.length && dist.length > 1) {
      truthy(
        '列表按距离升序',
        dist.every((v, i) => i === 0 || dist[i - 1] <= v),
        dist.map((v) => v.toFixed(2)).join(' ≤ ')
      );
    } else {
      skip('列表按距离升序', '模拟器未返回定位（已按门店顺序兜底）');
    }

    /* 下拉筛选：营业状态 */
    await tapXp(slPage, TXTIN('bar__item', '全部营业状态'));
    await sleep(600);
    eq('下拉面板已展开', (await slPage.data()).panel, 'state');
    await tapXp(slPage, TXC('panel__item', '仅看营业中'));
    await sleep(1800);
    const sl1 = await slPage.data();
    eq('仅看营业中已生效', sl1.onlyOpen, true);
    eq('下拉面板已收起', sl1.panel, '');
    truthy('结果全部为营业中', sl1.stores.every((s) => s.openNow), sl1.stores.length + ' 家');

    /* 下拉筛选：门店类型 */
    await tapXp(slPage, TXTIN('bar__item', '全部类型'));
    await sleep(600);
    await tapXp(slPage, TXC('panel__item', '直营店'));
    await sleep(1800);
    const sl2 = await slPage.data();
    eq('类型筛选已生效', sl2.type, 'DIRECT');
    truthy('结果全部为直营店', sl2.stores.every((s) => s.type === 'DIRECT'));

    /* 关键词搜索（叠加当前筛选条件） */
    await (await slPage.$('.filters__input')).input('东直门');
    await sleep(2000);
    const sl3 = await slPage.data();
    truthy('搜索命中', sl3.stores.length >= 1, sl3.stores.length + ' 家');
    truthy(
      '结果与关键词匹配',
      sl3.stores.every((s) => (s.name + s.address).indexOf('东直门') > -1),
      sl3.stores.map((s) => s.name).join('、')
    );

    /* 清空关键词 → 列表恢复 */
    await tapXp(slPage, ANY('filters__clear'));
    await sleep(2000);
    const sl4 = await slPage.data();
    eq('关键词已清空', sl4.keyword, '');
    truthy('列表已恢复（不少于命中结果）', sl4.stores.length >= sl3.stores.length, sl4.stores.length + ' 家');

    /* 点击门店 → 门店详情（顶部地图 + marker） */
    await tapXp(slPage, ANY('store__name'));
    await sleep(2000);
    const sdPage = await mini.currentPage();
    eq('跳转到门店详情', sdPage.path, 'pages/store-detail/store-detail');
    const sd0 = await sdPage.data();
    truthy('门店信息已加载', !!sd0.store, sd0.store && sd0.store.name);
    eq('地图组件已挂载', (await sdPage.$$('map')).length, 1);
    eq('门店 marker 已生成', sd0.markers.length, 1);
    truthy('地图中心点有效', sd0.center.latitude > 3 && sd0.center.longitude > 70);
    truthy('桌位文案已拼装', !!sd0.tableText, sd0.tableText);
    const useBtn = (await elOf(sdPage, TXC('btn-primary', '选为下单门店'))) || (await elOf(sdPage, TXC('btn-primary', '进入点单')));
    truthy('「选为下单门店」按钮存在', !!useBtn);

    /* ================= 19. 发票管理：抬头 → 待开票订单 → 提交申请 → 历史 → 详情 ================= */
    console.log('\n[19] 发票管理：抬头维护、开票申请与开票历史');
    const invPage = await mini.reLaunch('/packageUser/pages/invoice/invoice');
    await sleep(2400);
    eq('跳转到发票管理', invPage.path, 'packageUser/pages/invoice/invoice');
    eq('默认停留在「待开票订单」', (await invPage.data()).tab, 'orders');

    /* 抬头管理：新增公司抬头 */
    await tapXp(invPage, TXC('entry__text', '发票抬头管理'));
    await sleep(1600);
    const itPage = await mini.currentPage();
    eq('跳转到抬头管理', itPage.path, 'packageUser/pages/invoice-title/invoice-title');
    const itBefore = (await itPage.data()).list.length;
    await tapXp(itPage, TXC('btn-primary', '＋ 新增抬头'));
    await sleep(600);
    truthy('新增表单已弹出', (await itPage.data()).showForm);
    await tapXp(itPage, TXC('seg__item', '公司'));
    await sleep(400);
    const itFields = await itPage.$$('.field__input');
    eq('公司抬头出现税号输入', itFields.length, 3);
    await itFields[0].input('北京串串香科技有限公司');
    await itFields[1].input('91110101MA001X8N3K');
    await itFields[2].input('finance@lbz-demo.com');
    await tapXp(itPage, TXC('btn-primary', '保存'));
    await sleep(2000);
    const it1 = await itPage.data();
    eq('抬头已保存', it1.list.length, itBefore + 1);
    eq('抬头类型为公司', it1.list[0].titleType, 'company');
    eq('表单已关闭', it1.showForm, false);
    const titleCount = it1.list.length;

    await mini.navigateBack();
    await sleep(1600);
    const invPage2 = await mini.currentPage();
    await tapXp(invPage2, TXC('tabs__item', '开票历史'));
    await sleep(1600);
    eq('切到开票历史', (await invPage2.data()).tab, 'history');
    await tapXp(invPage2, TXC('tabs__item', '待开票订单'));
    await sleep(1800);

    const inv1 = await invPage2.data();
    if (inv1.orders.length) {
      truthy('待开票订单已列出', !!inv1.orders[0].orderNo, inv1.orders[0].orderNo);
      truthy('订单金额已格式化', /^\d+\.\d{2}$/.test(inv1.orders[0].amountYuan), inv1.orders[0].amountYuan);

      await tapXp(invPage2, TXC('order__btn', '申请开票'));
      await sleep(2000);
      const apPage = await mini.currentPage();
      eq('跳转到开票申请', apPage.path, 'packageUser/pages/invoice-apply/invoice-apply');
      const ap0 = await apPage.data();
      truthy('订单信息已加载', !!ap0.order, ap0.order && ap0.order.orderNo);
      eq('抬头可选', ap0.titles.length, titleCount);
      truthy('默认选中抬头', !!ap0.titleId, ap0.titleId);
      truthy('邮箱自动带出（抬头上记过）', !!ap0.email, ap0.email);
      eq('开票须知默认未勾选', ap0.agree, false);
      truthy('关联《开票须知》入口存在', !!(await elOf(apPage, TXC('agree__link', '《开票须知》'))));

      /* 未勾选须知时必须拦下 */
      await tapXp(apPage, TXC('btn-primary', '提交开票申请'));
      await sleep(800);
      eq('未同意须知时不提交', (await mini.currentPage()).path, 'packageUser/pages/invoice-apply/invoice-apply');
      eq('勾选状态仍为未同意', (await apPage.data()).agree, false);

      await tapXp(apPage, TXC('agree__text', '我已阅读并同意'));
      await sleep(500);
      eq('已勾选须知', (await apPage.data()).agree, true);
      await tapXp(apPage, TXC('btn-primary', '提交开票申请'));
      await sleep(2800);
      eq('提交后返回发票管理', (await mini.currentPage()).path, 'packageUser/pages/invoice/invoice');
      const inv2 = await invPage2.data();
      eq('待开票订单减少一条（一单只能开一张）', inv2.orders.length, inv1.orders.length - 1);
      eq('开票历史已新增', inv2.records.length, inv1.records.length + 1);
      eq('状态为待处理', inv2.records[0].status, 'PENDING');
      eq('状态文案正确', inv2.records[0].statusText, '待处理');
      truthy('抬头已快照到记录', /串串香/.test(inv2.records[0].title), inv2.records[0].title);

      /* 详情页：时间线 + 订单快照 */
      await tapXp(invPage2, TXC('tabs__item', '开票历史'));
      await sleep(1600);
      await tapXp(invPage2, ANY('his__title'));
      await sleep(2000);
      const dtPage = await mini.currentPage();
      eq('跳转到开票详情', dtPage.path, 'packageUser/pages/invoice-detail/invoice-detail');
      const dt0 = await dtPage.data();
      eq('时间线三步', dt0.steps.length, 3);
      eq('第一步已完成', dt0.steps[0].done, true);
      eq('第三步未完成', dt0.steps[2].done, false);
      truthy('订单快照已带出', !!dt0.rec.order, dt0.rec.order && dt0.rec.order.orderNo);
      truthy('明细已渲染', dt0.rec.order.items.length >= 1);
      truthy('实付金额有效', Number(dt0.rec.amount) > 0, dt0.rec.amount);
    } else if (inv1.records.length) {
      skip('提交开票申请全流程', '该订单上次运行已提交过申请（幂等保护），本次只校验历史与详情');
      await tapXp(invPage2, TXC('tabs__item', '开票历史'));
      await sleep(1600);
      const hist = (await invPage2.data()).records;
      truthy('开票历史非空', hist.length >= 1);
      truthy('状态文案合法', ['待处理', '开票中', '已开具', '已驳回'].indexOf(hist[0].statusText) > -1, hist[0].statusText);
    } else {
      bad('发票管理可开票订单', '既没有待开票订单也没有历史记录，无法验证开票链路');
    }
  } catch (e) {
    bad('测试中断', (e && e.message) || e);
    console.error(e);
  } finally {
    if (mini) {
      try {
        await mini.restoreWxMethod('showModal');
        await mini.restoreWxMethod('vibrateShort');
      } catch (e) {}
      try {
        await mini.disconnect();
      } catch (e) {}
    }
    console.log('\n========================================');
    console.log('  通过 ' + pass + ' 项 / 失败 ' + fails.length + ' 项');
    if (fails.length) fails.forEach((f) => console.log('  ! ' + f));
    console.log('========================================\n');
    process.exit(fails.length ? 1 : 0);
  }
})();
