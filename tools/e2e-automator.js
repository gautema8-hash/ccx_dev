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
  const tapXp = (page, xp) => page.getElementByXpath(xp).then(tap);
  /** 注意：带下标谓词的 XPath 形如 (//*[...])[4]，开头是 "(" 而不是 "/" */
  const isXpath = (s) => s.charAt(0) === '/' || s.charAt(0) === '(';
  const elOf = async (page, sel) => {
    try {
      return isXpath(sel) ? await page.getElementByXpath(sel) : await page.$(sel);
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

    /* ================= 0. 重置 ================= */
    console.log('[0.1] 重置：我的 → 清除本地缓存（清掉内存态购物车）');
    const mine0 = await mini.reLaunch('/pages/mine/mine');
    await mine0.waitFor(1600);
    await tapXp(mine0, TXT('清除本地缓存'));
    await sleep(800);
    ok('已重置本地状态');

    /* ================= 1. 首屏 ================= */
    console.log('\n[1] 点单页：首屏与菜单');
    const menu = await mini.reLaunch('/pages/menu/menu');
    await menu.waitFor(1800);
    let d = await menu.data();
    eq('页面路径', menu.path, 'pages/menu/menu');
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
    eq('列表加号数（= 需选辣度的菜品数）', (await menu.$$('.dish__add')).length, 19);

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

    await tap(await menu.getElementByXpath(NTH(IN('sku-opts', 'sku-opt'), 4))); // 特辣
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
    await mini.switchTab('/pages/cart/cart');
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
    await sleep(1400);

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
    await mini.switchTab('/pages/orders/orders');
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
    await mini.switchTab('/pages/menu/menu');
    await sleep(700);
    await mini.switchTab('/pages/orders/orders');
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
    await mini.switchTab('/pages/mine/mine');
    await sleep(1600);
    const md = await (await mini.currentPage()).data();
    eq('订单总数已统计', md.stats.orderCount, 1);
    /* 真实后端新客只发 1 张「新客立减券」，本流程中用掉 1 张 → 剩 0 张 */
    eq('未使用优惠券数量（1 张新客券用掉后为 0）', md.stats.couponCount, 0);
    eq('积分随完成订单到账', md.stats.points, 22);
    truthy('已拿到用户信息', !!md.user.openid, md.user.nickname);
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
