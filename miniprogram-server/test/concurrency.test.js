/* ============================================================
   并发 / 高并发测试
   ------------------------------------------------------------
   验证的是「高并发下不出错」，不是「QPS 有多高」：
     1. 防超卖：限量库存下 N 个并发下单，成功数必须 ≤ 库存
     2. 幂等：同 key 并发下单，只产生一笔
     3. 同用户并发下单：串行化，不产生重复订单
     4. 优惠券并发核销：一券只能用一次
     5. 支付并发回调：只结算一次
     6. 混合负载：批量下单 + 查单 + 支付同时跑，统计成功率与延迟分布
     7. 连接池与过载保护：不超过 MAX_INFLIGHT 时不出现 5xx

   前置：服务已启动，库已 migrate + seed
   运行：node test/concurrency.test.js
   ============================================================ */
const API = process.env.API_BASE || 'http://127.0.0.1:3000/miniapp/v1';
const ROOT = API.replace(/\/miniapp\/v1\/?$/, '');
/** 管理系统后端地址：管理端接口已拆到独立服务（默认 3001），路径前缀 /miniapp/v1/admin */
const ADMIN_API = process.env.ADMIN_API_BASE || 'http://127.0.0.1:3001/miniapp/v1/admin';
/** 根路径探针（health/ready/metrics）打到小程序后端 */
const API_ROOT = process.env.API_ROOT || 'http://127.0.0.1:3000';
/** 连锁版管理端走员工账号体系；库存是门店维度的，必须指定门店 */
const ADMIN_ACCOUNT = process.env.ADMIN_ACCOUNT || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@123456';
const DEFAULT_STORE = process.env.TEST_STORE_ID || 'st_dz';

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
const le = (label, a, b) => (a <= b ? ok(label, a + ' ≤ ' + b) : bad(label, `${a} > ${b}`));

/**
 * 路由到正确的服务：
 *   /admin/*  → 管理系统后端（3001，前缀 /miniapp/v1/admin）
 *   /health /ready /metrics → 小程序后端根路径
 *   其余       → 小程序后端（3000，前缀 /miniapp/v1）
 */
function isProbe(path) {
  return path === '/health' || path === '/ready' || path === '/metrics';
}
function baseOf(path) {
  if (path.indexOf('/admin') === 0) return ADMIN_API;
  if (isProbe(path)) return API_ROOT;
  return API;
}
function apiPathOf(path) {
  return path.indexOf('/admin') === 0 ? path.slice('/admin'.length) || '/' : path;
}

async function call(path, opt) {
  opt = opt || {};
  const t0 = Date.now();
  const res = await fetch(baseOf(path) + apiPathOf(path), {
    method: opt.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {}),
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let body;
  try {
    body = await res.json();
  } catch (e) {
    body = { code: -999, message: 'non-json' };
  }
  return { status: res.status, body, data: body && body.data, cost: Date.now() - t0 };
}
const H = (t) => ({ Authorization: 'Bearer ' + t });
const login = (code) => call('/auth/wechat-login', { method: 'POST', body: { code } }).then((r) => r.data);
async function adminLogin() {
  const r = await call('/admin/auth/login', { method: 'POST', body: { account: ADMIN_ACCOUNT, password: ADMIN_PASSWORD } });
  if (!r.data || !r.data.access_token) throw new Error('管理端登录失败：' + JSON.stringify(r.body));
  return H(r.data.access_token);
}
/** 设置某门店某菜品的库存 */
const setStock = (AH, dishId, stock) =>
  call('/admin/store-dishes', {
    method: 'POST',
    headers: AH,
    body: { storeId: DEFAULT_STORE, items: [{ dishId, stock }] },
  });
/** 读取某门店某菜品的库存快照 */
async function readStock(AH, dishId) {
  const r = await call('/admin/dishes?storeId=' + DEFAULT_STORE, { headers: AH });
  return (r.data.list || []).find((d) => d.id === dishId);
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

(async () => {
  console.log('\n=== 订单小程序 · 并发测试 ===\n');

  const AH = await adminLogin();
  /* 默认门店（未传 storeId 时）即本用例操作的门店，保证下单与查库存落在同一家 */
  const menu = await call('/menu?storeId=' + DEFAULT_STORE).then((r) => r.data);
  const dishA = menu.categories[0].dishes[0];
  const plainDish = menu.categories[0].dishes.find((d) => !d.spicy);
  const soup = menu.soups[0];

  /* ================= 1. 防超卖 ================= */
  console.log('[1] 防超卖：限量库存下并发抢购');
  const STOCK = 20;
  const CONCURRENCY = 60; // 远超库存
  const setRes = await setStock(AH, plainDish.id, STOCK);
  eq('预置门店库存成功', setRes.body.code, 0);

  const buyers = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => login('ccy_oversell_' + Date.now() + '_' + i))
  );
  const results = await Promise.all(
    buyers.map((u) =>
      call('/orders', {
        method: 'POST',
        headers: H(u.access_token),
        body: { items: [{ dishId: plainDish.id, count: 1 }], soup: { id: soup.id }, diningType: 'takeout' },
      })
    )
  );
  const succeeded = results.filter((r) => r.body.code === 0).length;
  const stockErr = results.filter((r) => r.body.code === 42001).length;
  const others = results.filter((r) => r.body.code !== 0 && r.body.code !== 42001);
  eq('成功下单数 = 库存', succeeded, STOCK);
  eq('库存不足被正确拒绝', stockErr, CONCURRENCY - succeeded);
  eq('没有其他类型的失败', others.length, 0, others.length ? JSON.stringify(others[0].body) : '');
  const afterStock = await readStock(AH, plainDish.id);
  eq('数据库库存精确归零（无超卖）', afterStock.storeStock, 0);
  truthy('销量准确累加', afterStock.storeSold >= STOCK, 'sold=' + afterStock.storeSold);

  /* ================= 2. 超卖后不能再下单 ================= */
  console.log('\n[2] 售罄后下单必须被拒');
  const uSold = await login('ccy_soldout_' + Date.now());
  const soldOut = await call('/orders', {
    method: 'POST',
    headers: H(uSold.access_token),
    body: { items: [{ dishId: plainDish.id, count: 1 }], soup: { id: soup.id }, diningType: 'takeout' },
  });
  eq('售罄菜品下单失败', soldOut.body.code, 42001);

  /* ================= 3. 幂等键并发 ================= */
  console.log('\n[3] 幂等：同 key 并发下单只产生一笔');
  const uIdem = await login('ccy_idem_' + Date.now());
  const idemKey = 'ccy_idem_' + Date.now();
  const before = (await call('/orders?filter=all&size=50', { headers: H(uIdem.access_token) })).data.length;
  const idemResults = await Promise.all(
    Array.from({ length: 5 }, () =>
      call('/orders', {
        method: 'POST',
        headers: Object.assign(H(uIdem.access_token), { 'Idempotency-Key': idemKey }),
        body: { items: [{ dishId: dishA.id, spicyId: 'sp1', count: 1 }], soup: { id: soup.id }, diningType: 'takeout' },
      })
    )
  );
  const created = new Set(idemResults.filter((r) => r.body.code === 0).map((r) => r.data.id));
  const after = (await call('/orders?filter=all&size=50', { headers: H(uIdem.access_token) })).data.length;
  le('并发同 key 最多产生 1 笔订单', after - before, 1);
  truthy('成功返回里订单 id 唯一', created.size <= 1, created.size + ' 个不同 id');

  /* ================= 4. 同用户并发下单（无幂等键） ================= */
  console.log('\n[4] 同用户并发下单：分布式锁串行化');
  const uLock = await login('ccy_lock_' + Date.now());
  const lockResults = await Promise.all(
    Array.from({ length: 6 }, () =>
      call('/orders', {
        method: 'POST',
        headers: H(uLock.access_token),
        body: { items: [{ dishId: dishA.id, spicyId: 'sp1', count: 1 }], soup: { id: soup.id }, diningType: 'takeout' },
      })
    )
  );
  const lockOk = lockResults.filter((r) => r.body.code === 0).length;
  const lockBusy = lockResults.filter((r) => r.body.code === 42900).length;
  eq('成功数 + 被锁数 = 总请求数', lockOk + lockBusy, 6);
  truthy('确实是「要么成功要么被锁」，没有 5xx', lockResults.every((r) => r.body.code === 0 || r.body.code === 42900), 'ok=' + lockOk + ' busy=' + lockBusy);

  /* ================= 5. 优惠券并发核销 ================= */
  console.log('\n[5] 优惠券：并发下只能用一次');
  const uCoupon = await login('ccy_coupon_' + Date.now());
  const myCoupons = await call('/user/coupons', { headers: H(uCoupon.access_token) }).then((r) => r.data);
  const cp = myCoupons.find((c) => c.threshold === 0) || myCoupons[0];
  truthy('拿到可用券', !!cp, cp && cp.name);
  const couponResults = await Promise.all(
    Array.from({ length: 4 }, () =>
      call('/orders', {
        method: 'POST',
        headers: H(uCoupon.access_token),
        body: {
          items: [{ dishId: dishA.id, spicyId: 'sp1', count: 2 }],
          soup: { id: soup.id },
          diningType: 'takeout',
          coupon: { id: cp.id },
        },
      })
    )
  );
  const couponOk = couponResults.filter((r) => r.body.code === 0);
  eq('同券并发只有 1 次成功', couponOk.length, 1);
  if (couponOk.length) {
    const withDiscount = await call('/orders/' + couponOk[0].data.id, { headers: H(uCoupon.access_token) });
    truthy('订单确实带上了抵扣', withDiscount.data.amount.discount > 0, '-' + withDiscount.data.amount.discount / 100 + ' 元');
  }
  const left = await call('/user/coupons', { headers: H(uCoupon.access_token) }).then((r) => r.data);
  eq('券已被核销（未使用数 -1）', left.length, myCoupons.length - couponOk.length);

  /* ================= 6. 支付并发结算 ================= */
  console.log('\n[6] 支付：并发结算只生效一次');
  const uPay = await login('ccy_pay_' + Date.now());
  const payOrder = await call('/orders', {
    method: 'POST',
    headers: H(uPay.access_token),
    body: { items: [{ dishId: dishA.id, spicyId: 'sp1', count: 1 }], soup: { id: soup.id }, diningType: 'takeout' },
  }).then((r) => r.data);
  await call('/orders/' + payOrder.id + '/prepay', { method: 'POST', headers: H(uPay.access_token) });
  const payResults = await Promise.all(
    Array.from({ length: 6 }, () => call('/orders/' + payOrder.id + '/mock-pay', { method: 'POST', headers: H(uPay.access_token) }))
  );
  eq('全部请求都返回成功（幂等）', payResults.filter((r) => r.body.code === 0).length, 6);
  const paidOrder = await call('/orders/' + payOrder.id, { headers: H(uPay.access_token) });
  eq('订单最终状态 PAID', paidOrder.data.status, 'PAID');
  const timeline = paidOrder.data.timeline;
  eq('时间轴里「支付成功」只出现一次', timeline.filter((t) => t.key === 'PAID').length, 1);

  /* ================= 7. 混合负载 + 延迟分布 ================= */
  console.log('\n[7] 混合负载：下单 / 查单 / 菜单 / 订单列表 同时压');
  const users = await Promise.all(Array.from({ length: 30 }, (_, i) => login('ccy_mix_' + Date.now() + '_' + i)));
  const costs = [];
  let http5xx = 0;
  let bizFail = 0;

  const tasks = [];
  for (let i = 0; i < 30; i++) {
    const u = users[i];
    tasks.push(
      call('/orders', {
        method: 'POST',
        headers: H(u.access_token),
        body: { items: [{ dishId: dishA.id, spicyId: 'sp1', count: 1 }], soup: { id: soup.id }, diningType: 'takeout' },
      }),
      call('/orders?filter=all&size=10', { headers: H(u.access_token) }),
      call('/menu', { headers: H(u.access_token) }),
      call('/user/stats', { headers: H(u.access_token) })
    );
  }
  const started = Date.now();
  const mixResults = await Promise.all(tasks);
  const elapsed = Date.now() - started;
  mixResults.forEach((r) => {
    costs.push(r.cost);
    if (r.status >= 500) http5xx++;
    else if (r.body.code !== 0) bizFail++;
  });
  eq('无 5xx', http5xx, 0);
  eq('无业务失败', bizFail, 0);
  truthy(
    '总耗时',
    true,
    tasks.length + ' 请求 / ' + elapsed + 'ms  (P50=' + percentile(costs, 0.5) + 'ms P95=' + percentile(costs, 0.95) + 'ms P99=' + percentile(costs, 0.99) + 'ms max=' + Math.max.apply(null, costs) + 'ms)'
  );
  le('P95 延迟', percentile(costs, 0.95), 500);

  /* ================= 8. 过载保护 ================= */
  console.log('\n[8] 过载与稳定性');
  const metrics = await call('/metrics').then((r) => r.data);
  ok('服务指标', 'total=' + metrics.total + ' reject=' + metrics.rejected + ' 5xx=' + metrics.serverError + ' slow=' + metrics.slow);
  eq('未触发过载拒绝（阈值内）', metrics.rejected, 0);
  eq('服务端未产生 5xx', metrics.serverError, 0);
  const stillAlive = await call('/health');
  eq('压测后服务仍健康', stillAlive.body.code, 0);

  console.log('\n========================================');
  console.log('  并发测试：通过 ' + pass + ' 项 / 失败 ' + fails.length + ' 项');
  if (fails.length) fails.forEach((f) => console.log('  ! ' + f));
  console.log('========================================\n');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('\n并发测试异常终止：', e);
  process.exit(1);
});
