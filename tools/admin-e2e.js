/**
 * admin-e2e.js —— 管理系统前端浏览器端到端测试
 *
 * ── 被测对象 ──
 *   admin-web（静态单页） + admin-server（3001） + miniprogram-server（3000，内部链路）
 *
 * ── 原理 ──
 *   ① 起一个「带反代的静态服务」：/ 返回 admin-web 静态文件，
 *      /miniapp/v1/admin/* 反代到 admin-server，保证同源、无 CORS 问题
 *   ② 用 puppeteer-core 驱动系统 Chrome（headless）打开页面，
 *      模拟真实运营人员的点击：登录 → 切换各菜单 → 断言数据 → 退出
 *
 * ── 前置 ──
 *   · admin-server(3001) 与 miniprogram-server(3000) 已启动
 *   · puppeteer-core 已装到隔离工作区（脚本自动注入 module.paths）
 *
 * ── 运行 ──
 *   node tools/admin-e2e.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

/* 注入隔离工作区（puppeteer-core 安装位置） */
module.paths.push('C:/Users/xuyan/.workbuddy/binaries/node/workspace/node_modules');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'admin-web');
const ADMIN_SERVER = process.env.ADMIN_API_BASE || 'http://127.0.0.1:3001';
const PORT = Number(process.env.ADMIN_E2E_PORT || 8090);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let pass = 0;
const fails = [];
const ok = (label, extra) => { pass++; console.log('  \x1b[32m✓\x1b[0m ' + label + (extra !== undefined ? '  → ' + extra : '')); };
const bad = (label, extra) => { fails.push(label + (extra !== undefined ? ' (' + extra + ')' : '')); console.log('  \x1b[31m✗\x1b[0m ' + label + (extra !== undefined ? '  → ' + extra : '')); };
const eq = (label, a, b) => (a === b ? ok(label, a) : bad(label, `got=${a} want=${b}`));
const truthy = (label, v, extra) => (v ? ok(label, extra) : bad(label, 'falsy'));

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

/** 带反代的静态服务 */
function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      if (u.startsWith('/miniapp/v1/admin')) {
        /* 反代到 admin-server */
        const upstream = http.request(ADMIN_SERVER + u, {
          method: req.method,
          headers: Object.assign({}, req.headers, { host: ADMIN_SERVER.replace(/^https?:\/\//, '') }),
        }, (ur) => {
          res.writeHead(ur.statusCode, ur.headers);
          ur.pipe(res);
        });
        upstream.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
        req.pipe(upstream);
        return;
      }
      let p = u === '/' ? '/index.html' : u;
      const f = path.join(WEB, p);
      if (f.indexOf(WEB) !== 0 || !fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  console.log('\n=== 老北京麻辣串串香 · 管理系统前端 E2E ===\n');
  const srv = await startServer();
  const puppeteer = require('puppeteer-core');

  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    ok('启动系统 Chrome（headless）', CHROME);
  } catch (e) {
    bad('启动 Chrome 失败', (e && e.message) || e);
    srv.close();
    process.exit(1);
  }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle0', timeout: 30000 });

    /* 1. 登录页 */
    const hasLogin = await page.$('#doLogin');
    truthy('打开后台出现登录页', !!hasLogin);

    /* 2. 登录 */
    await page.type('#ac', 'admin');
    await page.type('#pw', 'Admin@123456');
    await page.click('#doLogin');
    await page.waitForSelector('nav a[data-v="dashboard"]', { timeout: 15000 });
    ok('登录成功，进入经营看板');

    /* 3. 侧边菜单数量（admin 全权限 → 13 个菜单：含客服消息 / 发票管理 / 加盟配置 / 协议及政策） */
    const navCount = await page.$$eval('nav a', (a) => a.length);
    eq('侧边菜单数量（超管全权限）', navCount, 13);
    const me = await page.$eval('.me', (e) => e.textContent);
    truthy('显示当前登录人', me.indexOf('品牌管理员') > -1, me.trim().replace(/\s+/g, ' '));

    /* 4. 逐菜单断言 */
    const views = [
      { v: 'store', title: '门店管理', sub: '5 家' },
      { v: 'staff', title: '员工与权限', sub: '个账号' },
      { v: 'voucher', title: '团购券核销', has: '#vCode' },
      { v: 'theme', title: '主题管理', has: '.theme-preview' },
      { v: 'coupon', title: '优惠券', has: 'table' },
      { v: 'orders', title: '订单管理', has: 'table' },
      /* 本次新增的四个运营面板 */
      { v: 'service', title: '客服消息', has: '.svc' },
      { v: 'invoice', title: '发票管理', has: 'table' },
      { v: 'franchise', title: '加盟配置', has: 'input' },
      { v: 'agreement', title: '协议及政策', has: 'table' },
      { v: 'audit', title: '审计日志', has: 'table' },
      { v: 'dashboard', title: '经营看板', has: '.card' },
    ];
    for (const it of views) {
      await page.click('nav a[data-v="' + it.v + '"]');
      await page.waitForSelector('main h2', { timeout: 10000 });
      await page.waitForFunction((t) => document.querySelector('main h2') && document.querySelector('main h2').textContent.indexOf(t) > -1, {}, it.title).catch(() => {});
      const h2 = await page.$eval('main h2', (e) => e.textContent);
      truthy('菜单「' + it.title + '」可打开', h2.indexOf(it.title) > -1, h2.trim());
      if (it.sub) {
        await page.waitForFunction((s) => { const el = document.querySelector('main .sub'); return el && el.textContent.indexOf(s) > -1; }, { timeout: 10000 }, it.sub).catch(() => {});
        const sub = await page.$eval('main .sub', (e) => e.textContent).catch(() => '');
        truthy('「' + it.title + '」数据正确（含 ' + it.sub + '）', sub.indexOf(it.sub) > -1, sub.trim());
      }
      if (it.has) {
        const found = await page.$(it.has);
        truthy('「' + it.title + '」关键元素存在', !!found, it.has);
      }
    }

    /* 5. 门店选择器（数据隔离的可见体现）—— 在「菜单与库存」页（该页带门店下拉） */
    await page.click('nav a[data-v="dish"]');
    await page.waitForSelector('#storeSel', { timeout: 10000 });
    const storeOpts = await page.$$eval('#storeSel option', (o) => o.length);
    truthy('门店选择器可切换（多门店）', storeOpts >= 5, storeOpts + ' 个选项');

    /* 6. 退出登录 */
    await page.click('#btnLogout');
    await page.waitForSelector('#doLogin', { timeout: 10000 });
    ok('退出登录回到登录页');

    console.log('\n========================================');
    console.log('  管理系统前端 E2E：通过 ' + pass + ' 项 / 失败 ' + fails.length + ' 项');
    if (fails.length) fails.forEach((f) => console.log('  ! ' + f));
    console.log('========================================\n');
  } catch (e) {
    bad('E2E 异常中断', (e && e.message) || e);
  } finally {
    try { await browser.close(); } catch (e) {}
    srv.close();
  }
  process.exit(fails.length ? 1 : 0);
})();
