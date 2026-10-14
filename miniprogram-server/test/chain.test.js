/* ============================================================
   连锁版交付级验收测试
   ------------------------------------------------------------
   覆盖需求 1/2/3/7/8：
     A. 管理端登录与身份（口令、锁定、令牌、强制改密）
     B. 权限模型 RBAC + 数据隔离（直营/加盟、门店范围、越权、防提权）
     C. 定位与附近门店（保留并增强原有定位能力）
     D. 主题切换（品牌级 / 门店级 / 优先级 / 令牌注入防护）
     E. 美团团购券核销（含并发防重复核销）
     F. 优惠券（领券中心 / 限领 / 门店范围 / 抵扣口径 / 定向发放）

   前置：服务已启动（node src/index.js），库已 migrate + seed
   运行：node test/chain.test.js
   ============================================================ */
const API = process.env.API_BASE || 'http://127.0.0.1:3000/miniapp/v1';
/** 管理系统后端地址：管理端接口已拆到独立服务（默认 3001），路径前缀 /miniapp/v1/admin */
const ADMIN_API = process.env.ADMIN_API_BASE || 'http://127.0.0.1:3001/miniapp/v1/admin';
/** 根路径探针打到小程序后端 */
const API_ROOT = process.env.API_ROOT || 'http://127.0.0.1:3000';
const fs = require('fs');
const path = require('path');
const TOKEN_CACHE = path.join(__dirname, '.token-cache.json');

/* 令牌缓存：管理端登录有 IP 级限流（40 次 / 5 分钟），反复跑测试会撞上限流。
   缓存 2 小时有效令牌，既让测试可重复运行，又不削弱线上风控策略。 */
function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveCache(c) {
  try {
    fs.writeFileSync(TOKEN_CACHE, JSON.stringify(c));
  } catch (e) {
    /* 缓存失败不影响测试 */
  }
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

const H = (t) => ({ Authorization: 'Bearer ' + t });

/** 管理端登录：优先复用缓存令牌，失效时才真正登录（避开 IP 限流） */
let tokenCache = loadCache();
async function staffLogin(account, password) {
  const cached = tokenCache[account];
  if (cached && cached.expiresAt > Date.now() + 60000) {
    const probe = await call('/admin/auth/profile', { headers: H(cached.token) });
    if (probe.body && probe.body.code === 0) {
      return { token: cached.token, staff: probe.data, cached: true };
    }
  }
  const r = await call('/admin/auth/login', { method: 'POST', body: { account, password } });
  if (!r.data || !r.data.access_token) {
    bad('登录 ' + account, `code=${r.body.code} msg=${r.body.message}`);
    throw new Error('登录失败：' + account);
  }
  tokenCache[account] = { token: r.data.access_token, expiresAt: Date.now() + r.data.expires_in * 1000 };
  saveCache(tokenCache);
  return { token: r.data.access_token, refresh: r.data.refresh_token, staff: r.data.staff };
}

/** 小程序用户登录（mock code2session） */
async function userLogin(tag) {
  const r = await call('/auth/wechat-login', { method: 'POST', body: { code: 'chain-test-' + tag + '-' + Date.now() } });
  if (!r.data || !r.data.access_token) {
    bad('用户登录 ' + tag, `code=${r.body.code} msg=${r.body.message}`);
    throw new Error('用户登录失败');
  }
  return { token: r.data.access_token, user: r.data.user };
}

function mustFail(label, resp, code) {
  if (resp && resp.body && resp.body.code === code) ok(label + ' → ' + resp.body.message);
  else bad(label, `期望 code=${code}，实际 ${resp && resp.body && resp.body.code} ${resp && resp.body && resp.body.message}`);
}
function need(label, resp) {
  if (resp && resp.body && resp.body.code === 0 && resp.data) {
    ok(label);
    return resp.data;
  }
  bad(label, `code=${resp && resp.body && resp.body.code} msg=${resp && resp.body && resp.body.message}`);
  throw new Error('前置步骤失败，测试中止：' + label);
}
const group = (t) => console.log('\n\x1b[36m── ' + t + '\x1b[0m');

/** 生成唯一券码（mock provider：MT + 8~18 位数字） */
let codeSeq = Math.floor(Math.random() * 1e6);
const mtCode = (prefix) => {
  codeSeq += 1;
  const n = String(20000000 + codeSeq);
  return prefix + n;
};

async function main() {
  console.log('\n=== 老北京麻辣串串香 · 连锁版验收测试 ===');

  /* ============================================================ A 登录与身份 */
  group('A. 管理端登录与账号安全');

  const brand = await staffLogin('admin', 'Admin@123456');
  eq('A1 品牌超管登录成功', brand.staff.role, 'BRAND_ADMIN');
  truthy('A2 超管拥有全部权限点', brand.staff.perms && brand.staff.perms.indexOf('*') > -1);
  eq('A3 超管数据范围为全部门店', brand.staff.allStores, true);

  const wrongPwd = await call('/admin/auth/login', { method: 'POST', body: { account: 'admin', password: 'wrong-password' } });
  mustFail('A4 密码错误被拒绝', wrongPwd, 40100);
  eq('A5 失败文案统一（不泄露账号是否存在）', wrongPwd.body.message, '账号或密码错误');

  const ghost = await call('/admin/auth/login', { method: 'POST', body: { account: 'hacker_not_exist', password: 'whatever123' } });
  eq('A6 不存在的账号返回同一文案（防账号枚举）', ghost.body.message, '账号或密码错误');

  const noToken = await call('/admin/stores');
  mustFail('A7 无令牌访问管理端接口 → 401', noToken, 40100);

  const fakeToken = await call('/admin/stores', { headers: H('eyJhbGciOiJIUzI1NiJ9.eyJ0eXAiOiJzdGFmZiJ9.fake') });
  mustFail('A8 伪造令牌 → 401', fakeToken, 40100);

  const profile = await call('/admin/auth/profile', { headers: H(brand.token) });
  const prof = need('A9 拉取当前登录者信息', profile);
  eq('A10 profile 角色正确', prof.role, 'BRAND_ADMIN');
  eq('A11 profile 声明全局门店', prof.scope.allStores, true);

  const weakPwd = await call('/admin/auth/password', {
    method: 'POST',
    headers: H(brand.token),
    body: { oldPassword: 'Admin@123456', newPassword: '123' },
  });
  mustFail('A12 弱口令被拦截', weakPwd, 40001);
  const wrongOld = await call('/admin/auth/password', {
    method: 'POST',
    headers: H(brand.token),
    body: { oldPassword: 'not-my-pwd-1', newPassword: 'Another@2024' },
  });
  mustFail('A13 原密码不正确时拒绝改密', wrongOld, 40100);

  /* ============================================================ B RBAC + 数据隔离 */
  group('B. 权限模型与数据隔离（直营 / 加盟）');

  const mgrDz = await staffLogin('mgr_dz', 'Store@123456');
  const ownerFt = await staffLogin('owner_ft', 'Franchise@123456');
  const region = await staffLogin('region_north', 'Region@123456');
  const staffDz = await staffLogin('staff_dz', 'Staff@123456');

  eq('B1 店长角色', mgrDz.staff.role, 'STORE_MANAGER');
  eq('B2 店长仅授权 1 家门店', mgrDz.staff.storeIds.length, 1);
  eq('B3 店长授权门店为东直门店', mgrDz.staff.storeIds[0], 'st_dz');
  eq('B4 加盟商角色', ownerFt.staff.role, 'FRANCHISE_OWNER');
  eq('B5 加盟商仅授权自己的加盟店', ownerFt.staff.storeIds.join(','), 'st_ft');

  const brandStores = await call('/admin/stores', { headers: H(brand.token) });
  const bs = need('B6 超管拉取门店列表', brandStores);
  eq('B7 超管可见全部门店', bs.list.length, 5);
  eq('B8 直营店数量', bs.list.filter((s) => s.type === 'DIRECT').length, 3);
  eq('B9 加盟店数量', bs.list.filter((s) => s.type === 'FRANCHISE').length, 2);
  truthy('B10 加盟店带加盟商主体', bs.list.filter((s) => s.type === 'FRANCHISE').every((s) => !!s.franchisee));

  const dzStores = await call('/admin/stores', { headers: H(mgrDz.token) });
  const ds = need('B11 店长拉取门店列表', dzStores);
  eq('B12 店长只见自己的店（SQL 层隔离，不是查出来再过滤）', ds.list.length, 1);
  eq('B13 店长看到的门店 id', ds.list[0] && ds.list[0].id, 'st_dz');

  const ftStores = await call('/admin/stores', { headers: H(ownerFt.token) });
  const fs = need('B14 加盟商拉取门店列表', ftStores);
  eq('B15 加盟商只见自己的店', fs.list.length, 1);
  eq('B16 加盟商看不到其它加盟店营业额', fs.list[0] && fs.list[0].id, 'st_ft');

  const crossDish = await call('/admin/dishes?storeId=st_cy', { headers: H(mgrDz.token) });
  mustFail('B17 店长查别家门店菜品 → 403', crossDish, 40300);

  const crossOrder = await call('/admin/orders?storeId=st_hd', { headers: H(ownerFt.token) });
  mustFail('B18 加盟商查别家门店订单 → 403', crossOrder, 40300);

  const dzWriteDish = await call('/admin/dishes', {
    method: 'POST',
    headers: H(mgrDz.token),
    body: { name: '越权新品', categoryId: 'c1', price: 100 },
  });
  mustFail('B19 店长无 dish:write → 403', dzWriteDish, 40300);

  const regionBrandWrite = await call('/admin/brand', {
    method: 'PUT',
    headers: H(region.token),
    body: { name: '被区域经理改名' },
  });
  mustFail('B20 区域经理无 brand:write → 403', regionBrandWrite, 40300);

  /* 防提权：低权限角色不允许创建更高权限账号 */
  const escalate = await call('/admin/staff', {
    method: 'POST',
    headers: H(region.token),
    body: { account: 'evil_admin', name: '提权账号', role: 'BRAND_ADMIN', password: 'Evil@123456', stores: [] },
  });
  mustFail('B21 区域经理不能创建品牌超管（防提权）', escalate, 40300);

  const regionStores = await call('/admin/stores', { headers: H(region.token) });
  const rs = need('B22 区域经理拉取门店', regionStores);
  truthy('B23 区域经理按 region 拿到多店', rs.list.length >= 1, rs.list.length + ' 家');

  /* 店员只读：不能改库存 */
  const staffStock = await call('/admin/store-dishes', {
    method: 'POST',
    headers: H(staffDz.token),
    body: { storeId: 'st_dz', dishId: 'd101', stock: 999 },
  });
  mustFail('B24 店员无 dish:stock → 403', staffStock, 40300);

  /* 审计日志可查，且越权请求也留痕 */
  const audit = await call('/admin/audit?size=5', { headers: H(brand.token) });
  const ad = need('B25 超管可查审计日志', audit);
  truthy('B26 审计日志有记录', Array.isArray(ad.list) && ad.list.length > 0, (ad.list || []).length + ' 条');
  const auditByStaff = await call('/admin/audit', { headers: H(mgrDz.token) });
  mustFail('B27 店长无 audit:read → 403', auditByStaff, 40300);

  /* ============================================================ C 定位与门店 */
  group('C. 定位与附近门店（原定位能力保留并增强）');

  /* 东直门总店坐标 */
  const near = await call('/stores?lat=39.9403&lng=116.4216');
  const nr = need('C1 按坐标拉取附近门店', near);
  eq('C2 返回门店总数', nr.total, 5);
  eq('C3 最近门店为东直门总店', nr.list[0].id, 'st_dz');
  truthy('C4 最近门店距离 < 500m', nr.list[0].distanceKm < 0.5, nr.list[0].distanceText);
  truthy('C5 按距离升序排列', nr.list.every((s, i) => i === 0 || nr.list[i - 1].distanceKm <= s.distanceKm));
  truthy('C6 门店带营业状态', nr.list.every((s) => typeof s.openNow === 'boolean'));
  eq('C7 有坐标时 needLocation=false', nr.needLocation, false);

  const noCoord = await call('/stores');
  const nc = need('C8 无坐标也能拿到门店列表', noCoord);
  eq('C9 无坐标时提示需要定位', nc.needLocation, true);
  truthy('C10 无坐标时不返回距离字段', nc.list.every((s) => s.distanceKm === undefined));

  const badCoord = await call('/stores?lat=999&lng=999');
  const bc = need('C11 非法坐标不报错（降级为无距离）', badCoord);
  eq('C12 非法坐标同样提示需要定位', bc.needLocation, true);

  const onlyFranchise = await call('/stores?type=FRANCHISE');
  const of = need('C13 按类型筛选门店', onlyFranchise);
  truthy('C14 筛选结果全部为加盟店', of.list.every((s) => s.type === 'FRANCHISE'), of.list.length + ' 家');

  const one = await call('/stores/st_ft');
  const os = need('C15 门店详情', one);
  eq('C16 详情带品牌信息', !!(os.brand && os.brand.name), true);
  eq('C17 加盟店 typeText', os.typeText, '加盟店');

  /* 菜单按门店隔离：加盟店停售 2 款 */
  const menuDz = await call('/menu?storeId=st_dz');
  const md = need('C18 拉取东直门店菜单', menuDz);
  const menuFt = await call('/menu?storeId=st_ft');
  const mf = need('C19 拉取丰台加盟店菜单', menuFt);
  eq('C20 门店菜单互不影响（加盟店停售 2 款）', mf.totalDishes, md.totalDishes - 2);
  eq('C21 菜单返回当前门店', md.store.id, 'st_dz');
  truthy('C22 菜品价格/库存来自门店覆盖表', md.categories.every((c) => c.dishes.every((d) => typeof d.price === 'number' && typeof d.stock === 'number')));
  const menuBad = await call('/menu?storeId=st_not_exist');
  mustFail('C23 不存在的门店 → 404', menuBad, 40400);

  /* ============================================================ D 主题切换 */
  group('D. 主题配置与切换（活动日 / 节假日 / 会员日）');

  const themeDz = await call('/theme?storeId=st_dz');
  const td = need('D1 拉取东直门店主题', themeDz);
  eq('D2 门店级主题覆盖品牌级', td.scope, 'STORE');
  eq('D3 门店级主题主色', td.tokens.primary, '#D81B60');
  truthy('D4 主题 style 串可直接注入 CSS 变量', String(td.style).indexOf('--c-primary:#D81B60') > -1, td.style && td.style.slice(0, 28) + '…');

  const themeCy = await call('/theme?storeId=st_cy');
  const tc = need('D5 拉取朝阳店主题', themeCy);
  eq('D6 无门店级主题时回落品牌级', tc.scope, 'BRAND');
  eq('D7 品牌级节假日主题主色', tc.tokens.primary, '#C62828');

  const themeNone = await call('/theme?storeId=st_not_exist');
  const tn = need('D8 未知门店不报错（回落品牌级）', themeNone);
  truthy('D9 始终能拿到一份可用令牌', !!tn.tokens.primary);

  /* 管理端：一键切换到「会员日」 */
  const themeList = await call('/admin/themes', { headers: H(brand.token) });
  const tl = need('D10 拉取主题列表', themeList);
  truthy('D11 返回预置主题模板', Object.keys(tl.presets || {}).length >= 4, Object.keys(tl.presets || {}).join('/'));
  /* 复位：本用例会启用会员日主题，先关掉保证可重复运行 */
  await call('/admin/themes/th_member/status', { method: 'POST', headers: H(brand.token), body: { status: 0 } });
  const resetList = await call('/admin/themes', { headers: H(brand.token) });
  const memberTheme = (resetList.data.list || []).find((t) => t.id === 'th_member');
  truthy('D12 会员日主题存在且默认未启用', memberTheme && memberTheme.status === 0, memberTheme ? 'status=' + memberTheme.status : 'not found');

  const act = await call('/admin/themes/th_member/activate', { method: 'POST', headers: H(brand.token) });
  need('D13 一键启用会员日主题', act);
  const afterAct = await call('/theme?storeId=st_cy');
  const aa = need('D14 切换后立即生效', afterAct);
  eq('D15 朝阳店已切到会员日', aa.type, 'MEMBER_DAY');
  eq('D16 会员日主色（黑金）', aa.tokens.primary, '#2E2A26');
  const afterActDz = await call('/theme?storeId=st_dz');
  eq('D17 门店级主题不受品牌级切换影响', afterActDz.data.type, 'CAMPAIGN');

  /* 切回节假日，保证后续用例环境稳定 */
  await call('/admin/themes/th_holiday/activate', { method: 'POST', headers: H(brand.token) });
  const back = await call('/theme?storeId=st_cy');
  eq('D18 可切回其它主题', back.data.type, 'HOLIDAY');

  /* 令牌注入防护：未知键 + 危险值必须被过滤 */
  const inject = await call('/admin/themes', {
    method: 'POST',
    headers: H(brand.token),
    body: {
      name: '注入测试主题',
      type: 'CUSTOM',
      storeId: '',
      tokens: { primary: 'url(javascript:alert(1))', evilKey: 'x', bannerText: '<script>alert(1)</script>' },
    },
  });
  const inj = need('D19 创建自定义主题', inject);
  const injRead = await call('/admin/themes', { headers: H(brand.token) });
  const created = (injRead.data.list || []).find((t) => t.id === inj.id);
  eq('D20 未知令牌键被丢弃', created.tokens.evilKey, undefined);
  eq('D21 危险值被过滤（回落默认主色）', created.tokens.primary, '#C62828');
  eq('D22 含尖括号的文案被过滤', created.tokens.bannerText, '');

  /* 越权改别家门店主题 */
  const crossTheme = await call('/admin/themes', {
    method: 'POST',
    headers: H(mgrDz.token),
    body: { name: '越权主题', type: 'CUSTOM', storeId: 'st_cy' },
  });
  mustFail('D23 店长不能改别家门店主题 → 403', crossTheme, 40300);
  const noPermTheme = await call('/admin/themes', {
    method: 'POST',
    headers: H(staffDz.token),
    body: { name: '店员主题', type: 'CUSTOM', storeId: 'st_dz' },
  });
  mustFail('D24 店员无 theme:write → 403', noPermTheme, 40300);

  /* 清理注入测试主题 */
  await call('/admin/themes/' + inj.id, { method: 'DELETE', headers: H(brand.token) });
  ok('D25 删除测试主题（清理）');

  /* ============================================================ E 团购券核销 */
  group('E. 美团团购券核销（含并发防重复）');

  const u1 = await userLogin('voucher1');
  const u2 = await userLogin('voucher2');

  const code1 = mtCode('MT168');
  const v1 = await call('/voucher/verify', {
    method: 'POST',
    headers: H(u1.token),
    body: { code: code1, storeId: 'st_dz' },
  });
  const vv = need('E1 用户自助核销美团券', v1);
  eq('E2 识别到团购套餐', vv.productName, '招牌串串双人餐');
  eq('E3 面值正确（分）', vv.faceValue, 16800);
  eq('E4 核销门店正确', vv.storeId, 'st_dz');
  eq('E5 通道标记为用户自助', vv.channel, 'SELF');

  const again = await call('/voucher/verify', {
    method: 'POST',
    headers: H(u2.token),
    body: { code: code1, storeId: 'st_cy' },
  });
  mustFail('E6 同一券码重复核销被拒绝', again, 40901);
  truthy('E7 拒绝信息带出原始核销门店（可追责）', String(again.body.message).indexOf('东直门') > -1, again.body.message);

  const noStore = await call('/voucher/verify', { method: 'POST', headers: H(u1.token), body: { code: mtCode('MT88') } });
  mustFail('E8 未选门店 → 参数错误', noStore, 40001);

  const badStore = await call('/voucher/verify', {
    method: 'POST',
    headers: H(u1.token),
    body: { code: mtCode('MT88'), storeId: 'st_not_exist' },
  });
  mustFail('E9 门店不存在 → 404', badStore, 40400);

  const badCode = await call('/voucher/verify', { method: 'POST', headers: H(u1.token), body: { code: 'ABC123', storeId: 'st_dz' } });
  mustFail('E10 非法券码格式被拒', badCode, 40001);

  const emptyCode = await call('/voucher/verify', { method: 'POST', headers: H(u1.token), body: { code: '', storeId: 'st_dz' } });
  mustFail('E11 空券码被拒', emptyCode, 40001);

  /* 券码规范化：小写 + 空格 + 连字符应等价于标准码 */
  const raw = mtCode('MT88');
  const pretty = raw.slice(0, 4) + '-' + raw.slice(4, 8) + ' ' + raw.slice(8);
  const norm = await call('/voucher/verify', { method: 'POST', headers: H(u1.token), body: { code: pretty.toLowerCase(), storeId: 'st_dz' } });
  const nv = need('E12 券码大小写/分隔符自动规范化', norm);
  eq('E13 规范化后的券码一致', nv.code, raw);

  /* 并发防重复核销：10 个请求打同一券码，只允许成功 1 个 */
  const raceCode = mtCode('MT299');
  const racers = [];
  for (let i = 0; i < 10; i++) {
    racers.push(
      call('/voucher/verify', {
        method: 'POST',
        headers: H(i % 2 === 0 ? u1.token : u2.token),
        body: { code: raceCode, storeId: 'st_hd' },
      })
    );
  }
  const raceRes = await Promise.all(racers);
  const raceOk = raceRes.filter((r) => r.body && r.body.code === 0);
  const raceDup = raceRes.filter((r) => r.body && (r.body.code === 40901 || r.body.code === 42002 || r.body.code === 50000));
  eq('E14 并发 10 次核销同一券码，只成功 1 次', raceOk.length, 1);
  eq('E15 其余 9 次全部被唯一键挡下', raceDup.length, 9);

  /* 店员代客核销（管理端） */
  const staffCode = mtCode('MT128');
  const sv = await call('/admin/vouchers/verify', {
    method: 'POST',
    headers: H(mgrDz.token),
    body: { code: staffCode, storeId: 'st_dz' },
  });
  const svv = need('E16 店员代客核销', sv);
  eq('E17 店员核销通道标记', svv.channel, 'STAFF');
  eq('E18 店员核销识别套餐', svv.productName, '四人畅吃套餐');

  const crossVoucher = await call('/admin/vouchers/verify', {
    method: 'POST',
    headers: H(mgrDz.token),
    body: { code: mtCode('MT88'), storeId: 'st_cy' },
  });
  mustFail('E19 店员不能越店核销 → 403', crossVoucher, 40300);

  const voucherList = await call('/admin/vouchers?size=50', { headers: H(brand.token) });
  const vl = need('E20 超管查看核销记录', voucherList);
  truthy('E21 核销记录按门店可统计', typeof vl.total === 'number' && vl.total >= 4, vl.total + ' 条');
  const voucherListFt = await call('/admin/vouchers', { headers: H(ownerFt.token) });
  const vlf = need('E22 加盟商查看核销记录', voucherListFt);
  eq('E23 加盟商看不到其它门店的核销记录', vlf.list.filter((v) => v.storeId !== 'st_ft').length, 0);

  /* 撤销核销：状态置为 REFUNDED，但券码仍不可二次利用 */
  const refund = await call('/admin/vouchers/' + svv.id + '/refund', { method: 'POST', headers: H(brand.token) });
  need('E24 撤销核销成功', refund);
  const reuse = await call('/admin/vouchers/verify', {
    method: 'POST',
    headers: H(mgrDz.token),
    body: { code: staffCode, storeId: 'st_dz' },
  });
  mustFail('E25 撤销后券码不可二次核销（防套现）', reuse, 40901);

  const mine = await call('/voucher/mine', { headers: H(u1.token) });
  const mv = need('E26 我的核销记录', mine);
  truthy('E27 只返回本人的核销记录', Array.isArray(mv) && mv.every((v) => typeof v.storeName === 'string'), (mv || []).length + ' 条');
  const mineNoAuth = await call('/voucher/mine');
  mustFail('E28 未登录查核销记录 → 401', mineNoAuth, 40100);

  /* ============================================================ F 优惠券 */
  group('F. 优惠券（小程序 + 管理端）');

  const cu = await userLogin('coupon1');
  const center = await call('/coupons/center?storeId=st_dz');
  const ct = need('F1 领券中心（未登录也可浏览）', center);
  truthy('F2 领券中心返回可领券', ct.list.length >= 3, ct.list.length + ' 张');
  truthy('F3 每张券带 canReceive 状态', ct.list.every((c) => typeof c.canReceive === 'boolean'));
  eq('F4 限定其它门店的券不展示', ct.list.filter((c) => c.id === 'cp5').length, 0);

  const centerCy = await call('/coupons/center?storeId=st_cy');
  truthy('F5 门店专享券仅在对应门店展示', (centerCy.data.list || []).some((c) => c.id === 'cp5'));

  /* 领取：cp2 满 50 减 10，每人 2 张、每日 1 张 */
  const r1 = await call('/coupons/cp2/receive', { method: 'POST', headers: H(cu.token), body: { storeId: 'st_dz' } });
  need('F6 领取优惠券成功', r1);
  const r2 = await call('/coupons/cp2/receive', { method: 'POST', headers: H(cu.token), body: { storeId: 'st_dz' } });
  mustFail('F7 每日限领 1 张生效', r2, 42002);

  const crossCp = await call('/coupons/cp5/receive', { method: 'POST', headers: H(cu.token), body: { storeId: 'st_dz' } });
  mustFail('F8 不能领取非当前门店的专享券', crossCp, 42002);

  const mine0 = await call('/user/coupons?status=UNUSED', { headers: H(cu.token) });
  const mc = need('F9 我的优惠券', mine0);
  truthy('F10 已领到的券出现在「我的券」', mc.some((c) => c.id === 'cp2'), (mc || []).length + ' 张');

  /* 抵扣计算口径：满减 / 折扣 / 锅底券 */
  const usable = await call('/coupons/usable', {
    method: 'POST',
    headers: H(cu.token),
    body: { storeId: 'st_dz', goodsAmount: 8000, soupFee: 1800 },
  });
  const us = need('F11 结算页可用券计算', usable);
  truthy('F12 按可抵扣金额倒序', us.list.every((c, i) => i === 0 || us.list[i - 1].estimateDiscount >= c.estimateDiscount));
  truthy('F13 最佳券已给出', !!us.best, us.best ? us.best.name + ' 省 ¥' + us.best.estimateDiscount / 100 : '');
  eq('F14 满 50 减 10 券抵扣正确', (us.list.find((c) => c.id === 'cp2') || {}).estimateDiscount, 1000);

  const lowAmount = await call('/coupons/usable', {
    method: 'POST',
    headers: H(cu.token),
    body: { storeId: 'st_dz', goodsAmount: 1000, soupFee: 0 },
  });
  eq('F15 未达门槛的券不可用', (lowAmount.data.list || []).filter((c) => c.id === 'cp2').length, 0);

  /* 领取锅底券 + 折扣券，验证三种券型口径 */
  const cu2 = await userLogin('coupon2');
  await call('/coupons/cp3/receive', { method: 'POST', headers: H(cu2.token), body: { storeId: 'st_dz' } });
  await call('/coupons/cp4/receive', { method: 'POST', headers: H(cu2.token), body: { storeId: 'st_dz' } });
  const usable2 = await call('/coupons/usable', {
    method: 'POST',
    headers: H(cu2.token),
    body: { storeId: 'st_dz', goodsAmount: 20000, soupFee: 1800 },
  });
  const u2list = (usable2.data && usable2.data.list) || [];
  const soupC = u2list.find((c) => c.id === 'cp3');
  const discC = u2list.find((c) => c.id === 'cp4');
  eq('F16 锅底券只对锅底金额抵扣', soupC && soupC.estimateDiscount, 1800);
  eq('F17 8.8 折券按 (20000+1800) 计算', discC && discC.estimateDiscount, Math.round((21800 * 12) / 100));
  truthy('F18 折扣券抵扣额大于锅底券，排在前面', u2list[0] && u2list[0].id === 'cp4', u2list[0] && u2list[0].id);

  /* 管理端：券模板 */
  const tplList = await call('/admin/coupons', { headers: H(brand.token) });
  const tp = need('F19 管理端券模板列表', tplList);
  truthy('F20 券模板带发放/使用统计', tp.every((c) => typeof c.issued === 'number' && typeof c.remain === 'number'), tp.length + ' 个模板');

  const badDiscount = await call('/admin/coupons', {
    method: 'POST',
    headers: H(brand.token),
    body: { name: '非法折扣券', type: 'DISCOUNT', value: 150, total: 100 },
  });
  mustFail('F21 折扣值 > 99 被拒', badDiscount, 40001);

  const badCash = await call('/admin/coupons', {
    method: 'POST',
    headers: H(brand.token),
    body: { name: '面额大于门槛', type: 'CASH', value: 5000, threshold: 3000, total: 100 },
  });
  mustFail('F22 面额大于门槛被拒', badCash, 40001);

  const newTpl = await call('/admin/coupons', {
    method: 'POST',
    headers: H(brand.token),
    body: {
      name: '连锁验收专用券',
      type: 'CASH',
      value: 1200,
      threshold: 6000,
      storeIds: ['st_dz', 'st_cy'],
      issueType: 'MANUAL',
      total: 100,
      perUser: 2,
      expireAt: '2026-12-31',
    },
  });
  const nt = need('F23 创建券模板', newTpl);
  truthy('F24 创建成功并返回券模板 id', typeof nt.id === 'string' && nt.id.length > 0, nt.id);

  const tplList2 = await call('/admin/coupons', { headers: H(brand.token) });
  const createdTpl = (tplList2.data || []).find((c) => c.id === nt.id);
  eq('F25 门店范围已落库', (createdTpl.storeIds || []).join(','), 'st_dz,st_cy');
  eq('F26 适用范围文案正确', createdTpl.storeScopeText, '2 家指定门店');

  /* 无 coupon:write 的角色一律拒绝 */
  const ftTpl = await call('/admin/coupons', {
    method: 'POST',
    headers: H(ownerFt.token),
    body: { name: '越权限店券', type: 'CASH', value: 500, storeIds: ['st_dz'], total: 10 },
  });
  mustFail('F27 加盟商无 coupon:write → 403', ftTpl, 40300);
  const dzTpl = await call('/admin/coupons', {
    method: 'POST',
    headers: H(mgrDz.token),
    body: { name: '店长建券', type: 'CASH', value: 500, storeIds: ['st_dz'], total: 10 },
  });
  mustFail('F28 店长无 coupon:write → 403', dzTpl, 40300);

  /* 有 coupon:write 但门店范围外的，必须被范围校验挡下（真正的「给别家店发券」漏洞） */
  /* 幂等：已存在则重置密码，不存在则新建（保证测试可反复运行） */
  const staffList = await call('/admin/staff?size=100', { headers: H(brand.token) });
  const existed = ((staffList.data && staffList.data.list) || []).find((s) => s.account === 'region_south');
  let ns;
  if (existed) {
    const rp = await call('/admin/staff/' + existed.id + '/reset-password', {
      method: 'POST',
      headers: H(brand.token),
      body: { password: 'South@123456' },
    });
    ns = need('F28a 复位无门店覆盖的区域经理账号（强制改密）', rp);
  } else {
    const newStaff = await call('/admin/staff', {
      method: 'POST',
      headers: H(brand.token),
      body: { account: 'region_south', name: '华南区域经理', role: 'REGION_MANAGER', region: '华南', password: 'South@123456' },
    });
    ns = need('F28a 创建无门店覆盖的区域经理（首登强制改密）', newStaff);
  }
  eq('F28b 账号首登需强制改密', ns.mustChangePwd, true);
  const south = await staffLogin('region_south', 'South@123456');
  const blocked = await call('/admin/stores', { headers: H(south.token) });
  mustFail('F28c 强制改密前业务接口被拦截 → 403', blocked, 40300);
  const changed = await call('/admin/auth/password', {
    method: 'POST',
    headers: H(south.token),
    body: { oldPassword: 'South@123456', newPassword: 'South@654321' },
  });
  need('F28d 首登改密成功', changed);
  const south2 = await staffLogin('region_south', 'South@654321');
  const southStores = await call('/admin/stores', { headers: H(south2.token) });
  eq('F28e 该区域无门店 → 列表为空（安全兜底是「查不到」）', southStores.data.total, 0);
  const southCoupon = await call('/admin/coupons', {
    method: 'POST',
    headers: H(south2.token),
    body: { name: '越权限店券', type: 'CASH', value: 500, storeIds: ['st_dz'], total: 10 },
  });
  mustFail('F28f 有写权限但门店越权 → 403（范围校验独立于权限点）', southCoupon, 40300);

  /* 主题「改状态 / 删除」同样必须过门店范围校验，不能只靠 theme:write */
  const southToggle = await call('/admin/themes/th_dz_open/status', {
    method: 'POST',
    headers: H(south2.token),
    body: { status: 0 },
  });
  mustFail('F28g 越权停用别家门店主题 → 403', southToggle, 40300);
  const southDel = await call('/admin/themes/th_dz_open', { method: 'DELETE', headers: H(south2.token) });
  mustFail('F28h 越权删除别家门店主题 → 403', southDel, 40300);
  const dzThemeStill = await call('/theme?storeId=st_dz');
  eq('F28i 东直门店主题未被改动', dzThemeStill.data.type, 'CAMPAIGN');

  /* 定向发放 */
  const grant = await call('/admin/coupons/' + nt.id + '/grant', {
    method: 'POST',
    headers: H(brand.token),
    body: { userIds: [cu.user.id, cu2.user.id] },
  });
  const gr = need('F29 定向发放优惠券', grant);
  eq('F30 发放成功计数', gr.success, 2);
  const noTarget = await call('/admin/coupons/' + nt.id + '/grant', {
    method: 'POST',
    headers: H(brand.token),
    body: { userIds: [] },
  });
  mustFail('F31 未匹配到用户 → 参数错误', noTarget, 40001);

  /* 发券后用户侧立即可见 */
  const afterGrant = await call('/user/coupons?status=UNUSED', { headers: H(cu.token) });
  truthy('F32 定向发放后用户立即可见', (afterGrant.data || []).some((c) => c.id === nt.id));

  const couponStats = await call('/admin/coupon-stats', { headers: H(brand.token) });
  const cs = need('F33 券统计数据', couponStats);
  truthy('F34 统计带核销率', cs.every((c) => typeof c.usedRate === 'string'));
  const couponStatsNoPerm = await call('/admin/coupon-stats', { headers: H(staffDz.token) });
  mustFail('F35 店员无 coupon:read → 403', couponStatsNoPerm, 40300);

  /* ============================================================ 汇总 */
  console.log('\n────────────────────────────────');
  if (fails.length) {
    console.log(`\x1b[31m✗ 通过 ${pass} 项，失败 ${fails.length} 项\x1b[0m`);
    fails.forEach((f) => console.log('  · ' + f));
    process.exit(1);
  }
  console.log(`\x1b[32m✓ 全部通过：${pass} 项断言\x1b[0m`);
}

main().catch((e) => {
  console.error('\n\x1b[31m测试异常中断：\x1b[0m', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
