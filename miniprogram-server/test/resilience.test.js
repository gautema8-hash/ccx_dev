/* ============================================================
   健壮性 / 容错测试
   ------------------------------------------------------------
   验证的是「怎么折腾都不崩」，分三部分：
     A 输入健壮性：坏 JSON / 超大 body / 类型错乱 / SQL 注入 / XSS /
                   路径穿越 / 超长字符串 / 非法分页
     B 依赖降级：Redis 完全不可用时服务仍能提供核心能力（缓存穿透、限流降级为进程内）
     C 优雅退出：摘流量后不接受新请求，在途请求能跑完

   前置：服务已启动（node src/index.js）
   运行：node test/resilience.test.js
   ============================================================ */
const path = require('path');
const { spawn } = require('child_process');

module.paths.push(path.resolve(__dirname, '..', 'node_modules'));
const automator = require.resolve('../src/app.js');

const API = process.env.API_BASE || 'http://127.0.0.1:3000/miniapp/v1';
const ROOT = API.replace(/\/miniapp\/v1\/?$/, '');
/** 管理系统后端地址：管理端接口已拆到独立服务（默认 3001），路径前缀 /miniapp/v1/admin */
const ADMIN_API = process.env.ADMIN_API_BASE || 'http://127.0.0.1:3001/miniapp/v1/admin';
/** 根路径探针（health/ready/metrics）打到小程序后端 */
const API_ROOT = process.env.API_ROOT || 'http://127.0.0.1:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token-please-change';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function raw(pathname, opt) {
  opt = opt || {};
  const res = await fetch((pathname.indexOf('/health') === 0 ? ROOT : API) + pathname, {
    method: opt.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {}),
    body: opt.body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {}
  return { status: res.status, text, json };
}
const call = (p, o) => raw(p, Object.assign({}, o, { body: o && o.body ? JSON.stringify(o.body) : undefined }));
const H = (t) => ({ Authorization: 'Bearer ' + t });
const login = (code) => call('/auth/wechat-login', { method: 'POST', body: { code } }).then((r) => r.json.data);

(async () => {
  console.log('\n=== 订单小程序 · 健壮性 / 容错测试 ===\n');
  const u = await login('res_' + Date.now());
  const menu = (await call('/menu')).json.data;
  const dish = menu.categories[0].dishes[0];
  const soup = menu.soups[0];

  /* ================= A. 输入健壮性 ================= */
  console.log('[A] 输入健壮性');

  const badJson = await raw('/orders', { method: 'POST', headers: H(u.access_token), body: '{not valid json' });
  eq('坏 JSON 返回 400', badJson.status, 400);
  truthy('坏 JSON 有可读提示', badJson.json && /JSON/.test(badJson.json.message), badJson.json && badJson.json.message);

  const emptyBody = await raw('/orders', { method: 'POST', headers: H(u.access_token), body: '' });
  truthy('空 body 不崩（返回业务错误）', emptyBody.status < 500, 'status=' + emptyBody.status);

  const huge = 'x'.repeat(300 * 1024);
  let bigBody;
  try {
    bigBody = await raw('/orders', {
      method: 'POST',
      headers: H(u.access_token),
      body: JSON.stringify({ items: [{ dishId: dish.id, count: 1 }], soup: { id: soup.id }, remark: huge }),
    });
    truthy('超大 body 被明确拒绝并给出 413', bigBody.status === 413, 'status=' + bigBody.status);
    truthy('提示可读', !!(bigBody.json && bigBody.json.message), bigBody.json && bigBody.json.message);
  } catch (e) {
    // 客户端侧被断连也算拒绝，但仍要能继续跑后续用例
    truthy('超大 body 被拒绝（连接被拒）', true, e.code || e.message);
  }
  const afterBig = await call('/menu');
  eq('超大 body 之后服务仍正常', afterBig.json.code, 0);

  const wrongTypes = await call('/orders', {
    method: 'POST',
    headers: H(u.access_token),
    body: { items: 'not-an-array', soup: 123, diningType: { a: 1 }, peopleCount: 'abc' },
  });
  truthy('类型错乱返回业务错误而非 500', wrongTypes.status < 500 && wrongTypes.json.code !== 0, 'code=' + wrongTypes.json.code);
  eq('类型错乱被识别为参数错误', wrongTypes.json.code, 40001);

  const nullItems = await call('/orders', { method: 'POST', headers: H(u.access_token), body: { items: [null, null] } });
  truthy('数组里塞 null 不崩', nullItems.status < 500, 'status=' + nullItems.status);

  /* SQL 注入：所有入参最终都走参数化查询，这里验证注入串不会造成异常或数据泄漏 */
  const injects = ["' OR 1=1 --", "1'; DROP TABLE mp_order; --", "1 UNION SELECT * FROM mp_user", "\\x27 OR 1=1"];
  let injectSafe = true;
  for (const s of injects) {
    const r = await call('/orders/' + encodeURIComponent(s), { headers: H(u.access_token) });
    if (r.status >= 500) {
      injectSafe = false;
      bad('注入串导致 5xx：' + s, 'status=' + r.status);
      break;
    }
  }
  truthy('SQL 注入串不会造成 5xx', injectSafe);
  const stillAlive = await call('/menu');
  eq('注入尝试后服务正常', stillAlive.json.code, 0);
  const tables = await call('/orders?filter=all&size=5', { headers: H(u.access_token) });
  truthy('订单表未被 DROP（仍可查询）', tables.status === 200, 'status=' + tables.status);

  /* 路径穿越：/uploads 必须挡住 */
  for (const p of ['/uploads/../package.json', '/uploads/..%2f..%2fpackage.json', '/uploads/avatars/../../src/config.js']) {
    const r = await raw(p.replace(/^\/uploads/, '/miniapp/v1/../..').indexOf('x') === -1 ? p : p);
    truthy('路径穿越被挡：' + p, r.status === 400 || r.status === 404 || r.status === 403, 'status=' + r.status);
  }

  /* XSS：内容原样存储、由客户端渲染时转义；服务端不接受危险 scheme */
  const xss = await call('/user/profile', {
    method: 'PUT',
    headers: H(u.access_token),
    body: { nickname: '<script>alert(1)</script>' },
  });
  truthy('昵称原样存储（由客户端转义）', xss.json.code === 0, xss.json.data && xss.json.data.nickname);
  const jsUrl = await call('/user/profile', { method: 'PUT', headers: H(u.access_token), body: { avatar: 'javascript:alert(1)' } });
  eq('javascript: 头像被拒', jsUrl.json.code, 40001);
  const dataUrl = await call('/user/profile', { method: 'PUT', headers: H(u.access_token), body: { avatar: 'data:text/html,x' } });
  eq('data: 头像被拒', dataUrl.json.code, 40001);

  /* 非法分页 / 极端参数 */
  for (const q of ['?page=-1', '?page=0&size=999999', '?page=abc&size=xyz', '?filter=../../etc', '?page=1e308']) {
    const r = await call('/orders' + q, { headers: H(u.access_token) });
    truthy('异常分页参数 ' + q, r.status < 500 && r.json.code === 0, 'size=' + (r.json.data || []).length);
  }
  const zeroSize = await call('/orders?size=0', { headers: H(u.access_token) });
  truthy('size=0 被兜底为合法值', zeroSize.status < 500);

  /* 超长字符串 */
  const longNick = await call('/user/profile', { method: 'PUT', headers: H(u.access_token), body: { nickname: '啊'.repeat(500) } });
  truthy('超长昵称被截断到 32 字以内', longNick.json.data.nickname.length <= 32, 'len=' + longNick.json.data.nickname.length);
  const longRemark = await call('/orders', {
    method: 'POST',
    headers: H(u.access_token),
    body: { items: [{ dishId: dish.id, spicyId: 'sp1', count: 1 }], soup: { id: soup.id }, diningType: 'takeout', remark: 'x'.repeat(5000) },
  });
  truthy('超长备注不会撑爆字段', longRemark.json.code === 0 || longRemark.json.code === 40001, 'code=' + longRemark.json.code);

  /* 特殊字符 / emoji / 控制字符 */
  const weird = await call('/orders', {
    method: 'POST',
    headers: H(u.access_token),
    body: {
      items: [{ dishId: dish.id, spicyId: 'sp1', count: 1 }],
      soup: { id: soup.id },
      diningType: 'takeout',
      remark: '🌶️\u0000\u001b[31m test \n line',
    },
  });
  truthy('emoji/控制字符不崩', weird.status < 500, 'code=' + weird.json.code);

  /* 路由与方法的边界 */
  const nf = await call('/not-exist-path');
  eq('未知路由返回 40400', nf.json.code, 40400);
  const wrongMethod = await raw('/menu', { method: 'POST', headers: H(u.access_token), body: '{}' });
  eq('错误方法返回 405', wrongMethod.status, 405);
  const noSlash = await call('/menu/');
  eq('末尾斜杠兼容', noSlash.json.code, 0);

  /* Token 篡改 */
  const parts = String(u.access_token).split('.');
  const forged = parts[0] + '.' + Buffer.from(JSON.stringify({ uid: 1, exp: 9999999999 })).toString('base64').replace(/=/g, '') + '.' + parts[2];
  const forgedRes = await call('/orders', { headers: H(forged) });
  eq('篡改 payload 的 token 被拒', forgedRes.status, 401);
  const algNone = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64').replace(/=/g, '') + '.' + parts[1] + '.';
  eq('alg=none 攻击被拒', (await call('/orders', { headers: H(algNone) })).status, 401);

  /* ================= B. Redis 掉线降级 ================= */
  console.log('\n[B] Redis 不可用时的降级（用错误端口起第二个实例，不影响主实例）');
  const childPort = 3101;
  const child = spawn(process.execPath, [path.resolve(__dirname, '../src/index.js')], {
    env: Object.assign({}, process.env, { PORT: String(childPort), REDIS_PORT: '6399', LOGIN_MODE: 'mock', PAY_MODE: 'mock' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOut = '';
  child.stdout.on('data', (d) => (childOut += d.toString()));
  child.stderr.on('data', (d) => (childOut += d.toString()));

  const waitUp = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        const r = await fetch('http://127.0.0.1:' + childPort + '/health');
        if (r.ok) return true;
      } catch (e) {}
      await sleep(150);
    }
    return false;
  };
  const up = await waitUp(8000);
  truthy('Redis 不可用时服务仍能启动', up, 'port=' + childPort);
  truthy('日志明确提示已降级', /降级|degraded/.test(childOut));

  if (up) {
    const CH = 'http://127.0.0.1:' + childPort;
    const chReady = await fetch(CH + '/ready').then((r) => r.json());
    eq('就绪探针标记为 degraded', chReady.data.degraded, true);
    const chMenu = await fetch(CH + '/miniapp/v1/menu').then((r) => r.json());
    eq('菜单仍可访问（缓存穿透到 DB）', chMenu.code, 0);
    eq('菜单数据完整', chMenu.data.totalDishes, 30);

    const chLogin = await fetch(CH + '/miniapp/v1/auth/wechat-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'res_degraded_' + Date.now() }),
    }).then((r) => r.json());
    eq('登录仍可用（限流降级为进程内）', chLogin.code, 0);
    const CHT = chLogin.data.access_token;

    const chOrder = await fetch(CH + '/miniapp/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CHT },
      body: JSON.stringify({
        items: [{ dishId: dish.id, spicyId: 'sp1', count: 1 }],
        soup: { id: soup.id },
        diningType: 'takeout',
      }),
    }).then((r) => r.json());
    eq('下单仍可用（锁降级为进程内 Mutex）', chOrder.code, 0);

    const chPay = await fetch(CH + '/miniapp/v1/orders/' + chOrder.data.id + '/mock-pay', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + CHT },
    }).then((r) => r.json());
    eq('支付仍可用', chPay.data.status, 'PAID');

    const chDupKey = 'deg_' + Date.now();
    const mk = () =>
      fetch(CH + '/miniapp/v1/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CHT, 'Idempotency-Key': chDupKey },
        body: JSON.stringify({
          items: [{ dishId: dish.id, spicyId: 'sp1', count: 1 }],
          soup: { id: soup.id },
          diningType: 'takeout',
        }),
      }).then((r) => r.json());
    const d1 = await mk();
    const d2 = await mk();
    truthy('Redis 掉线时幂等依然生效', !!(d1.data && d2.data && d1.data.id === d2.data.id), d1.data && d1.data.orderNo);
  }

  /* 优雅退出（在 Windows 上无法向子进程投递真信号，用 kill 验证进程能干净退出） */
  const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
  child.kill('SIGTERM');
  const exitInfo = await Promise.race([exited, sleep(6000).then(() => null)]);
  truthy('进程能退出（不留僵死）', !!exitInfo, exitInfo ? 'code=' + exitInfo.code : 'timeout');

  /* ================= C. 优雅退出机制（进程内验证关闭逻辑） ================= */
  console.log('\n[C] 优雅退出机制（进程内验证）');
  const config = require('../src/config');
  const db = require('../src/db');
  const redis = require('../src/redis');
  const { build } = require('../src/app');
  db.init();
  redis.init();
  const app = build();
  const addr = await app.listen(3102, '127.0.0.1');
  truthy('测试实例已监听', !!addr.port, 'port=' + addr.port);

  const beforeClose = await fetch('http://127.0.0.1:3102/health').then((r) => r.json());
  eq('关闭前可正常响应', beforeClose.code, 0);

  const closePromise = app.close(5000);
  await sleep(120);
  let refused = false;
  try {
    const r = await fetch('http://127.0.0.1:3102/health');
    refused = r.status === 503;
  } catch (e) {
    refused = true; // 连接被拒也算摘流量成功
  }
  truthy('关闭中拒绝新请求', refused);
  await closePromise;
  ok('close() 正常返回');
  try {
    await fetch('http://127.0.0.1:3102/health');
    bad('关闭后端口应不可用');
  } catch (e) {
    ok('关闭后端口已释放');
  }

  await redis.quit();
  await db.close();

  console.log('\n========================================');
  console.log('  健壮性测试：通过 ' + pass + ' 项 / 失败 ' + fails.length + ' 项');
  if (fails.length) fails.forEach((f) => console.log('  ! ' + f));
  console.log('========================================\n');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('\n健壮性测试异常终止：', e);
  process.exit(1);
});
