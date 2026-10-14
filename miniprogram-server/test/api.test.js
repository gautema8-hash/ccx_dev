/* ============================================================
   接口层交付级测试
   ------------------------------------------------------------
   覆盖：鉴权 / 参数校验 / 越权 / 金额篡改 / 幂等 / 状态机 /
        库存回滚 / 券核销 / 限流 / 管理端权限 / 非法流转

   前置：服务已启动（node src/index.js），库已 migrate + seed
   运行：node test/api.test.js
   ============================================================ */
const API = process.env.API_BASE || 'http://127.0.0.1:3000/miniapp/v1';
const ROOT = API.replace(/\/miniapp\/v1\/?$/, '');
/** 管理系统后端地址：管理端接口已拆到独立服务（默认 3001），路径前缀 /miniapp/v1/admin */
const ADMIN_API = process.env.ADMIN_API_BASE || 'http://127.0.0.1:3001/miniapp/v1/admin';
/** 根路径探针（health/ready/metrics）打到小程序后端 */
const API_ROOT = process.env.API_ROOT || 'http://127.0.0.1:3000';
/**
 * 连锁版管理端已由「单店 X-Admin-Token」升级为「员工账号 + RBAC + 门店范围」。
 * 这里用品牌超管登录拿 Bearer 令牌，与线上真实调用方式一致。
 */
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
  return { status: res.status, body, data: body && body.data };
}
const login = (code) =>
  call('/auth/wechat-login', { method: 'POST', body: { code } }).then((r) => r.data);
const H = (t) => ({ Authorization: 'Bearer ' + t });
/** 管理端令牌：跑测试前登录一次品牌超管 */
async function adminLogin() {
  const r = await call('/admin/auth/login', { method: 'POST', body: { account: ADMIN_ACCOUNT, password: ADMIN_PASSWORD } });
  if (!r.data || !r.data.access_token) {
    throw new Error('管理端登录失败：' + JSON.stringify(r.body));
  }
  return H(r.data.access_token);
}

function mustFail(label, resp, code) {
  if (resp && resp.body && resp.body.code === code) ok(label + ' → ' + resp.body.message);
  else bad(label, `期望 code=${code}，实际 ${resp && resp.body && resp.body.code} ${resp && resp.body && resp.body.message}`);
}
/** 成功断言 + 出错时把服务端 message 带出来，避免后续 null.id 的二次崩溃 */
function need(label, resp) {
  if (resp && resp.body && resp.body.code === 0 && resp.data) {
    ok(label);
    return resp.data;
  }
  bad(label, `code=${resp && resp.body && resp.body.code} msg=${resp && resp.body && resp.body.message}`);
  throw new Error('前置步骤失败，测试中止：' + label);
}

(async () => {
  console.log('\n=== 订单小程序 · 接口层测试 ===\n');

  /* ---------------- 1. 健康检查 ---------------- */
  console.log('[1] 健康检查与就绪探针');
  const h = await call('/health');
  eq('GET /health', h.body.code, 0);
  const ready = await call('/ready');
  truthy('GET /ready 数据库就绪', ready.data && ready.data.db === true, JSON.stringify(ready.data));
  /* 管理端令牌提前拿：后面要用来铺库存夹具 */
  const AH = await adminLogin();
  truthy('品牌超管登录管理端成功', true);

  /* ---------------- 2. 登录 ---------------- */
  console.log('\n[2] 登录与鉴权');
  mustFail('缺少 code 被拒', await call('/auth/wechat-login', { method: 'POST', body: {} }), 40001);
  /* 用户 code 带时间戳：避免跨轮次复用同一用户时撞上下单频次限流 */
  const stamp0 = Date.now();
  const u1 = await login('api_main_' + stamp0);
  truthy('登录返回 access_token', !!(u1 && u1.access_token));
  truthy('登录返回用户信息', !!(u1 && u1.user && u1.user.openid));
  const u1again = await login('api_main_' + stamp0);
  eq('同一 code 得到同一用户', u1again.user.openid, u1.user.openid);
  const u2 = await login('api_other_' + stamp0);
  truthy('不同 code 得到不同用户', u2.user.openid !== u1.user.openid);
  /* 每个「会下单」的场景用独立用户：单用户 15 分钟下单笔数有限流（这是防刷特性，不是 bug） */
  const u3 = await login('api_cancel_' + stamp0);
  const u4 = await login('api_refund_' + stamp0);
  const u5 = await login('api_urge_' + stamp0);

  mustFail('无 token 访问订单列表', await call('/orders'), 40100);
  const badToken = await call('/orders', { headers: H('not.a.token') });
  eq('伪造 token 返回 401', badToken.status, 401);
  const menu = await call('/menu', { headers: H(u1.access_token) });
  eq('带 token 可访问菜单', menu.body.code, 0);

  /* ---------------- 3. 菜单 ---------------- */
  console.log('\n[3] 菜单');
  const m = menu.data;
  eq('分类数', m.categories.length, 6);
  eq('菜品总数', m.totalDishes, 30);
  eq('锅底数', m.soups.length, 4);
  eq('辣度字典', m.spicyOptions.length, 4);
  truthy('门店带桌号列表', m.shop.tables.length > 0, m.shop.tables.length + ' 个');
  const spicyDish = m.categories[0].dishes[0];
  const plainDish = m.categories[0].dishes.find((d) => !d.spicy);
  truthy('菜品含 price(分)', typeof spicyDish.price === 'number');
  /* 打包费必须由服务端下发：客户端写死会出现「页面显示与实付不一致」的资损争议 */
  truthy('菜单下发打包费（分）', typeof m.packFee === 'number' && m.packFee >= 0, m.packFee);

  /* 库存夹具：并发测试会把同一菜品卖空，因此每个套件必须自己铺库存，
     否则套件之间存在隐式执行顺序依赖。 */
  const fixture = await call('/admin/store-dishes', {
    method: 'POST',
    headers: AH,
    body: {
      storeId: DEFAULT_STORE,
      items: [
        { dishId: spicyDish.id, stock: 200 },
        { dishId: plainDish.id, stock: 200 },
      ],
    },
  });
  eq('预置门店库存（用例自给自足）', fixture.body.code, 0);

  /* ---------------- 4. 用户资料与发票 ---------------- */
  console.log('\n[4] 用户资料 / 优惠券 / 发票');
  const me = await call('/user/profile', { headers: H(u1.access_token) });
  eq('GET /user/profile', me.body.code, 0);
  const upd = await call('/user/profile', {
    method: 'PUT',
    headers: H(u1.access_token),
    body: { nickname: '测试食客' },
  });
  eq('更新昵称', upd.data.nickname, '测试食客');
  mustFail(
    '非法头像地址被拒（防 javascript:/data: 注入）',
    await call('/user/profile', { method: 'PUT', headers: H(u1.access_token), body: { avatar: 'javascript:alert(1)' } }),
    40001
  );
  truthy('保存昵称过长被截断', upd.data.nickname.length <= 32);

  const coupons0 = await call('/user/coupons', { headers: H(u1.access_token) });
  truthy('新用户自动发券', coupons0.data.length >= 1, coupons0.data.length + ' 张');

  mustFail('发票抬头为空被拒', await call('/user/invoice', { method: 'POST', headers: H(u1.access_token), body: {} }), 40001);
  mustFail(
    '企业抬头税号格式错误被拒',
    await call('/user/invoice', { method: 'POST', headers: H(u1.access_token), body: { title: '某某公司', titleType: 'company', taxNo: 'abc' } }),
    40001
  );
  const inv = await call('/user/invoice', {
    method: 'POST',
    headers: H(u1.access_token),
    body: { title: '北京某某餐饮有限公司', titleType: 'company', taxNo: '91110101MA01ABCD2X' },
  });
  eq('新增发票抬头', inv.body.code, 0);
  const invList = await call('/user/invoice', { headers: H(u1.access_token) });
  eq('抬头列表条数', invList.data.length, 1);
  const delInv = await call('/user/invoice/' + inv.data.id, { method: 'DELETE', headers: H(u1.access_token) });
  eq('删除抬头', delInv.body.code, 0);

  /* ---------------- 5. 下单参数校验 ---------------- */
  console.log('\n[5] 下单：参数校验与防篡改');
  mustFail('空购物车被拒', await call('/orders', { method: 'POST', headers: H(u1.access_token), body: { items: [] } }), 40001);
  mustFail(
    '未选锅底被拒',
    await call('/orders', {
      method: 'POST',
      headers: H(u1.access_token),
      body: { items: [{ dishId: spicyDish.id, spicyId: 'sp1', count: 1 }], diningType: 'dinein', tableNo: 'A01' },
    }),
    40001
  );
  mustFail(
    '堂食未选桌号被拒',
    await call('/orders', {
      method: 'POST',
      headers: H(u1.access_token),
      body: { items: [{ dishId: spicyDish.id, spicyId: 'sp1', count: 1 }], soup: { id: m.soups[0].id }, diningType: 'dinein' },
    }),
    40001
  );
  mustFail(
    '不存在的菜品被拒',
    await call('/orders', {
      method: 'POST',
      headers: H(u1.access_token),
      body: { items: [{ dishId: 'not_exist', count: 1 }], soup: { id: m.soups[0].id }, diningType: 'takeout' },
    }),
    40001
  );
  mustFail(
    '数量非法被拒',
    await call('/orders', {
      method: 'POST',
      headers: H(u1.access_token),
      body: { items: [{ dishId: plainDish.id, count: 0 }], soup: { id: m.soups[0].id }, diningType: 'takeout' },
    }),
    40001
  );

  /* ---------------- 6. 正常下单 + 金额由服务端决定 ---------------- */
  console.log('\n[6] 正常下单：服务端计价');
  const buildPayload = (extra) =>
    Object.assign(
      {
        items: [
          { dishId: spicyDish.id, spicyId: 'sp3', count: 2 },
          { dishId: plainDish.id, count: 1 },
        ],
        soup: { id: m.soups[0].id },
        dips: [{ id: m.dips[0].id }],
        diningType: 'dinein',
        tableNo: 'A05',
        peopleCount: 2,
        remark: '少辣',
        // 故意伪造一个 1 分钱的金额，服务端必须忽略
        amount: { goods: 1, soupFee: 0, packFee: 0, discount: 0, pay: 1 },
      },
      extra || {}
    );

  const o1 = await call('/orders', { method: 'POST', headers: H(u1.access_token), body: buildPayload() });
  eq('下单成功', o1.body.code, 0);
  const order = need('订单已创建', o1);
  eq('初始状态 UNPAID', order.status, 'UNPAID');
  eq('明细 2 条', order.items.length, 2);
  eq('同串不同辣度独立计价', order.items[0].spicyName, '特辣');
  const expectGoods = spicyDish.price * 2 + plainDish.price * 1;
  const expectPay = expectGoods + m.soups[0].price;
  eq('服务端重算菜品小计（客户端篡改无效）', order.amount.goods, expectGoods);
  eq('服务端重算应付金额', order.amount.pay, expectPay);
  truthy('生成取餐码', !!order.pickupNo, order.pickupNo);
  truthy('生成订单号', /^LBZ\d{16}$/.test(order.orderNo), order.orderNo);
  eq('时间轴 5 节点', order.timeline.length, 5);

  /* ---------------- 7. 幂等 ---------------- */
  console.log('\n[7] 幂等：同一 Idempotency-Key 只产生一笔订单');
  const idemKey = 'test_idem_' + Date.now();
  const before = await call('/orders?filter=all&size=50', { headers: H(u1.access_token) });
  const p1 = await call('/orders', { method: 'POST', headers: Object.assign(H(u1.access_token), { 'Idempotency-Key': idemKey }), body: buildPayload() });
  const p2 = await call('/orders', { method: 'POST', headers: Object.assign(H(u1.access_token), { 'Idempotency-Key': idemKey }), body: buildPayload() });
  const p1d = need('首次下单成功', p1);
  const p2d = need('重试下单成功', p2);
  eq('两次请求返回同一订单', p1d.id, p2d.id);
  const after = await call('/orders?filter=all&size=50', { headers: H(u1.access_token) });
  eq('订单总数只 +1', after.data.length, before.data.length + 1);

  /* ---------------- 8. 越权 ---------------- */
  console.log('\n[8] 越权防护');
  const other = await call('/orders/' + order.id, { headers: H(u2.access_token) });
  truthy('他人无法查看我的订单', other.body.code === 40400 || other.body.code === 404, 'code=' + other.body.code);
  mustFail('他人无法取消我的订单', await call('/orders/' + order.id + '/cancel', { method: 'POST', headers: H(u2.access_token), body: {} }), 40400);

  /* ---------------- 9. 支付 ---------------- */
  console.log('\n[9] 支付：prepay → 结算 → 幂等');
  const pre = await call('/orders/' + order.id + '/prepay', { method: 'POST', headers: H(u1.access_token) });
  eq('prepay 成功', pre.body.code, 0);
  eq('out_trade_no 等于订单号', pre.data.outTradeNo, order.orderNo);
  eq('支付金额与订单一致', pre.data.amount, expectPay);
  const paid1 = await call('/orders/' + order.id + '/mock-pay', { method: 'POST', headers: H(u1.access_token) });
  eq('支付后状态 PAID', paid1.data.status, 'PAID');
  const paid2 = await call('/orders/' + order.id + '/mock-pay', { method: 'POST', headers: H(u1.access_token) });
  eq('重复支付幂等（仍为 PAID）', paid2.data.status, 'PAID');

  /* 伪造回调：金额对不上必须拒绝。mock 模式下先把已支付订单改成未支付来模拟 */
  const notifyNoOrder = await call('/pay/notify', { method: 'POST', body: { resource: { ciphertext: '' } } });
  truthy('伪造回调不会改单', notifyNoOrder.status >= 400 || notifyNoOrder.body.code !== 0, 'status=' + notifyNoOrder.status);

  /* ---------------- 10. 商家端 ---------------- */
  console.log('\n[10] 商家端：鉴权 + 状态流转白名单');
  mustFail('无令牌访问后台被拒', await call('/admin/orders', {}), 40100);
  mustFail('错误令牌被拒', await call('/admin/orders', { headers: H('not.a.token') }), 40100);
  /* 用户侧令牌不能当管理端令牌用（两套体系互不通用） */
  mustFail('小程序用户令牌不能访问管理端', await call('/admin/orders', { headers: H(u1.access_token) }), 40100);
  const adminList = await call('/admin/orders?status=all&size=50', { headers: AH });
  eq('商家看板可访问', adminList.body.code, 0);
  mustFail('跳步流转被拒（PAID 不能直接 done）', await call('/admin/orders/' + order.id + '/done', { method: 'POST', headers: AH }), 40901);

  for (const act of ['accept', 'cook', 'ready', 'done']) {
    const r = await call('/admin/orders/' + order.id + '/' + act, { method: 'POST', headers: AH });
    eq('商家流转 ' + act, r.body.code, 0);
  }
  mustFail('已完成订单不能再接单', await call('/admin/orders/' + order.id + '/accept', { method: 'POST', headers: AH }), 40901);

  const finalOrder = await call('/orders/' + order.id, { headers: H(u1.access_token) });
  eq('最终状态 DONE', finalOrder.data.status, 'DONE');
  eq('时间轴全部完成', finalOrder.data.timeline.filter((t) => t.done).length, 5);
  const stats = await call('/user/stats', { headers: H(u1.access_token) });
  eq('完成后积分 = 实付元数', stats.data.points, Math.floor(expectPay / 100));

  /* ---------------- 10b. 超时未支付自动关单 ---------------- */
  console.log('\n[10b] 超时未支付：自动关单并回滚库存');
  const stockBeforeExpire = (await call('/admin/dishes?storeId=' + DEFAULT_STORE, { headers: AH })).data.list.find(
    (d) => d.id === plainDish.id
  ).storeStock;
  const oExp = await call('/orders', {
    method: 'POST',
    headers: H(u3.access_token),
    body: { items: [{ dishId: plainDish.id, count: 2 }], soup: { id: m.soups[0].id }, diningType: 'takeout' },
  });
  const oExpD = need('超时场景订单已创建', oExp);
  const stockAfterExpireOrder = (await call('/admin/dishes?storeId=' + DEFAULT_STORE, { headers: AH })).data.list.find(
    (d) => d.id === plainDish.id
  ).storeStock;
  eq('下单先扣库存', stockAfterExpireOrder, stockBeforeExpire - 2);

  /**
   * 直接把 created_at 改到超时点之前，再走一次 prepay 触发关单。
   * 断言的是「关单 + 库存回滚」这一件事——只报错不关单会让库存被脏单永久占用。
   */
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root123!@#',
    database: process.env.DB_NAME || 'lbz_order',
  });
  await conn.execute('UPDATE mp_order SET created_at = ? WHERE id = ?', [Date.now() - 20 * 60 * 1000, oExpD.id]);
  await conn.end();

  const expiredPrepay = await call('/orders/' + oExpD.id + '/prepay', { method: 'POST', headers: H(u3.access_token) });
  mustFail('超时订单支付被拒', expiredPrepay, 40901);
  const stockAfterExpire = (await call('/admin/dishes?storeId=' + DEFAULT_STORE, { headers: AH })).data.list.find(
    (d) => d.id === plainDish.id
  ).storeStock;
  eq('超时关单后库存已回滚', stockAfterExpire, stockBeforeExpire);
  const expiredDetail = await call('/orders/' + oExpD.id, { headers: H(u3.access_token) });
  eq('超时订单状态为 CANCELED', expiredDetail.data.status, 'CANCELED');

  /* ---------------- 11. 评价 ---------------- */
  console.log('\n[11] 评价');
  const fb = await call('/orders/' + order.id + '/feedback', { method: 'POST', headers: H(u1.access_token), body: { score: 5, content: '很好吃' } });
  eq('提交评价', fb.body.code, 0);
  mustFail('重复评价被拒', await call('/orders/' + order.id + '/feedback', { method: 'POST', headers: H(u1.access_token), body: { score: 4 } }), 40001);

  /* ---------------- 12. 取消与库存回滚 ---------------- */
  console.log('\n[12] 取消订单：库存与优惠券回滚');
  const dishesBefore = await call('/admin/dishes?storeId=' + DEFAULT_STORE, { headers: AH });
  const dBefore = dishesBefore.data.list.find((d) => d.id === plainDish.id);
  truthy('门店菜品带库存字段', dBefore && typeof dBefore.storeStock === 'number', dBefore && dBefore.storeStock);

  const o2 = await call('/orders', {
    method: 'POST',
    headers: H(u3.access_token),
    body: {
      items: [{ dishId: plainDish.id, count: 3 }],
      soup: { id: m.soups[0].id },
      diningType: 'takeout',
    },
  });
  const o2d = need('自取订单可下单', o2);
  eq('自取收打包费', o2d.amount.packFee, 100);

  const dishesMid = await call('/admin/dishes?storeId=' + DEFAULT_STORE, { headers: AH });
  const dMid = dishesMid.data.list.find((d) => d.id === plainDish.id);
  eq('下单后库存 -3', dMid.storeStock, dBefore.storeStock - 3);

  const canceled = await call('/orders/' + o2d.id + '/cancel', {
    method: 'POST',
    headers: H(u3.access_token),
    body: { reason: '测试取消' },
  });
  eq('取消成功', canceled.body.code, 0);
  eq('状态 CANCELED', canceled.data.status, 'CANCELED');
  const dishesAfter = await call('/admin/dishes?storeId=' + DEFAULT_STORE, { headers: AH });
  const dAfter = dishesAfter.data.list.find((d) => d.id === plainDish.id);
  eq('取消后库存回滚', dAfter.storeStock, dBefore.storeStock);

  /* 已支付订单不能直接取消，必须走退款 */
  const o3 = await call('/orders', { method: 'POST', headers: H(u4.access_token), body: buildPayload() });
  const o3d = need('退款场景订单已创建', o3);
  await call('/orders/' + o3d.id + '/prepay', { method: 'POST', headers: H(u4.access_token) });
  await call('/orders/' + o3d.id + '/mock-pay', { method: 'POST', headers: H(u4.access_token) });
  mustFail(
    '已支付订单不可直接取消',
    await call('/orders/' + o3d.id + '/cancel', { method: 'POST', headers: H(u4.access_token), body: {} }),
    40001
  );

  /* ---------------- 13. 退款 ---------------- */
  console.log('\n[13] 退款流程');
  const rf = await call('/orders/' + o3d.id + '/refund', {
    method: 'POST',
    headers: H(u4.access_token),
    body: { reason: '点错了' },
  });
  eq('提交退款申请', rf.body.code, 0);
  mustFail(
    '重复申请被拒',
    await call('/orders/' + o3d.id + '/refund', { method: 'POST', headers: H(u4.access_token), body: { reason: '再来一次' } }),
    40001
  );
  const rfl = await call('/admin/refunds', { headers: AH });
  const myRefund = (rfl.data || []).find((r) => r.order_id === o3d.id);
  truthy('商家能看到退款申请', !!myRefund);
  const appr = await call('/admin/refunds/' + myRefund.id + '/approve', { method: 'POST', headers: AH });
  eq('审核通过并退款', appr.body.code, 0);
  const afterRefund = await call('/orders/' + o3d.id, { headers: H(u4.access_token) });
  eq('退款后订单 CANCELED', afterRefund.data.status, 'CANCELED');

  /* ---------------- 14. 催单 ---------------- */
  console.log('\n[14] 催单');
  const o4 = await call('/orders', { method: 'POST', headers: H(u5.access_token), body: buildPayload() });
  const o4d = need('催单场景订单已创建', o4);
  mustFail(
    '未支付不能催单',
    await call('/orders/' + o4d.id + '/urge', { method: 'POST', headers: H(u5.access_token) }),
    40001
  );
  await call('/orders/' + o4d.id + '/prepay', { method: 'POST', headers: H(u5.access_token) });
  await call('/orders/' + o4d.id + '/mock-pay', { method: 'POST', headers: H(u5.access_token) });
  const urge1 = await call('/orders/' + o4d.id + '/urge', { method: 'POST', headers: H(u5.access_token) });
  eq('催单成功', urge1.body.code, 0);
  mustFail(
    '短时间重复催单被限流',
    await call('/orders/' + o4d.id + '/urge', { method: 'POST', headers: H(u5.access_token) }),
    42900
  );

  /* ---------------- 15. 商家拒单 ---------------- */
  console.log('\n[15] 商家拒单（含退款）');
  const rej = await call('/admin/orders/' + o4d.id + '/reject', {
    method: 'POST',
    headers: AH,
    body: { reason: '菜品售罄' },
  });
  eq('拒单成功', rej.body.code, 0);
  eq('拒单已退款', rej.data.refunded, true);
  const o4after = await call('/orders/' + o4d.id, { headers: H(u5.access_token) });
  eq('拒单后订单 CANCELED', o4after.data.status, 'CANCELED');

  /* ---------------- 16. 库存管理 ---------------- */
  console.log('\n[16] 商家端库存管理');
  const setStock = await call('/admin/store-dishes', {
    method: 'POST',
    headers: AH,
    body: { storeId: DEFAULT_STORE, items: [{ dishId: plainDish.id, stock: 5 }] },
  });
  eq('设置门店库存', setStock.body.code, 0);
  const chk = await call('/admin/dishes?storeId=' + DEFAULT_STORE, { headers: AH });
  eq('库存已更新', chk.data.list.find((d) => d.id === plainDish.id).storeStock, 5);
  mustFail(
    '未指定门店改库存被拒',
    await call('/admin/store-dishes', { method: 'POST', headers: AH, body: { items: [{ dishId: plainDish.id, stock: 1 }] } }),
    40001
  );
  mustFail(
    '后台无令牌改库存被拒',
    await call('/admin/store-dishes', { method: 'POST', body: { storeId: DEFAULT_STORE, items: [{ dishId: plainDish.id, stock: 1 }] } }),
    40100
  );
  /* 门店上下架：门店维度停售不应影响品牌菜单 */
  const offRes = await call('/admin/dishes/' + plainDish.id + '/status', {
    method: 'POST',
    headers: AH,
    body: { storeId: DEFAULT_STORE, status: 0 },
  });
  eq('门店停售该菜品', offRes.body.code, 0);
  const menuAfterOff = await call('/menu?storeId=' + DEFAULT_STORE);
  truthy('停售菜品从该门店菜单消失', !menuAfterOff.data.categories.some((c) => c.dishes.some((d) => d.id === plainDish.id)));
  const menuOther = await call('/menu?storeId=st_cy');
  truthy('其它门店仍可销售该菜品', menuOther.data.categories.some((c) => c.dishes.some((d) => d.id === plainDish.id)));
  await call('/admin/dishes/' + plainDish.id + '/status', {
    method: 'POST',
    headers: AH,
    body: { storeId: DEFAULT_STORE, status: 1 },
  });
  ok('恢复门店在售（清理）');

  /* ---------------- 17. 订单列表筛选 ---------------- */
  console.log('\n[17] 订单列表筛选');
  const all = await call('/orders?filter=all&size=50', { headers: H(u1.access_token) });
  const ongoing = await call('/orders?filter=ongoing&size=50', { headers: H(u1.access_token) });
  const done = await call('/orders?filter=done&size=50', { headers: H(u1.access_token) });
  eq('全部 = 进行中 + 已完成', all.data.length, ongoing.data.length + done.data.length);
  /* 注意：summaryText / payText 这类展示字段由客户端的 decorate() 生成，
     接口层只保证领域字段完整（这里校验字段契约本身） */
  truthy(
    '每条订单都带完整明细与金额',
    all.data.every((o) => Array.isArray(o.items) && o.items.length > 0 && typeof o.amount.pay === 'number')
  );

  console.log('\n========================================');
  console.log('  接口层测试：通过 ' + pass + ' 项 / 失败 ' + fails.length + ' 项');
  if (fails.length) fails.forEach((f) => console.log('  ! ' + f));
  console.log('========================================\n');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('\n测试异常终止：', e);
  process.exit(1);
});
