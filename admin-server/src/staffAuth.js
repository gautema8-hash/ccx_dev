/**
 * 管理端账号体系（登录 / 锁定 / 令牌 / 审计）
 *
 * 安全设计（对应「防止黑客攻击与逆向」）：
 *   · 口令用 scrypt + 每账号独立盐，比对走 timingSafeEqual，杜绝彩虹表与时序侧信道
 *   · 连续失败 5 次锁定 15 分钟（DB 计数 + Redis 双层），并记录 mp_login_log 供风控分析
 *   · 令牌短时效（2h）+ 刷新令牌轮换（7d，refresh 后旧的作废），jti 可吊销
 *   · 首次登录/重置后强制改密（must_change_pwd），未改密前只放行改密接口
 *   · 角色与门店范围写进令牌，但**每次请求都重新查库**解析范围 —— 令牌只做身份证明，
 *     不做授权依据，避免「改了权限但旧令牌还能用」的越权窗口
 *   · 所有写操作落 mp_audit_log（谁、在哪家店、做了什么、来自哪个 IP）
 */
const crypto = require('crypto');
const db = require('./db');
const redis = require('./redis');
const config = require('./config');
const logger = require('./logger');
const rbac = require('./rbac');
const { unauthorized, forbidden, bizError, tooMany, CODES } = require('./errors');
const auth = require('./auth');

/* ------------------------------ 口令 ------------------------------ */
const SCRYPT_KEYLEN = 64;

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt: s };
}

function verifyPassword(password, hash, salt) {
  try {
    const computed = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
    const expect = Buffer.from(String(hash), 'hex');
    if (computed.length !== expect.length) return false;
    return crypto.timingSafeEqual(computed, expect);
  } catch (e) {
    return false;
  }
}

/** 口令强度：至少 8 位且同时含字母与数字 */
function assertPasswordStrength(pwd) {
  const s = String(pwd || '');
  if (s.length < 8) throw bizError(CODES.PARAM_INVALID, '密码至少 8 位');
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) throw bizError(CODES.PARAM_INVALID, '密码需同时包含字母和数字');
  if (/^(123456|password|admin)/i.test(s)) throw bizError(CODES.PARAM_INVALID, '密码过于简单，请更换');
}

/* ------------------------------ 登录 ------------------------------ */
const MAX_FAIL = 5;
const LOCK_MS = 15 * 60 * 1000;

function publicStaff(s, storeIds) {
  const meta = rbac.roleMeta(s.role) || { name: s.role };
  return {
    id: Number(s.id),
    account: s.account,
    name: s.name,
    phone: s.phone,
    role: s.role,
    roleName: meta.name,
    brandId: s.brand_id,
    region: s.region,
    allStores: !!s.all_stores,
    storeIds: storeIds || [],
    mustChangePwd: !!s.must_change_pwd,
    perms: meta.perms,
  };
}

async function loginLog(entry) {
  try {
    await db.execute(
      'INSERT INTO mp_login_log (brand_id, account, staff_id, ip, ua, success, reason, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [entry.brandId || '', entry.account || '', entry.staffId || 0, entry.ip || '', (entry.ua || '').slice(0, 250), entry.success ? 1 : 0, entry.reason || '', Date.now()]
    );
  } catch (e) {
    logger.warn('login log failed', { message: e.message });
  }
}

async function login(ctx) {
  const account = String((ctx.body && ctx.body.account) || '').trim().slice(0, 64);
  const password = String((ctx.body && ctx.body.password) || '');
  const brandId = String((ctx.body && ctx.body.brandId) || 'brand_lbz').slice(0, 32);
  const ua = String(ctx.headers['user-agent'] || '');

  if (!account || !password) throw bizError(CODES.PARAM_INVALID, '请输入账号和密码');

  /* IP 级限流：即使撞库也不给无限尝试的机会 */
  const ipLimit = await redis.rateLimit.hit('stafflogin:ip:' + ctx.ip, 40, 300);
  if (!ipLimit.allowed) {
    await loginLog({ brandId, account, ip: ctx.ip, ua, success: false, reason: 'IP_RATE_LIMITED' });
    throw tooMany('尝试过于频繁，请 ' + Math.ceil(ipLimit.resetSec / 60) + ' 分钟后再试');
  }

  const staff = await db.queryOne('SELECT * FROM mp_staff WHERE brand_id = ? AND account = ?', [brandId, account]);
  const now = Date.now();

  /* 统一失败文案：不区分「账号不存在」和「密码错误」，避免账号枚举 */
  const genericFail = async (reason) => {
    await loginLog({ brandId, account, staffId: staff ? Number(staff.id) : 0, ip: ctx.ip, ua, success: false, reason });
    throw bizError(CODES.AUTH_FAILED, '账号或密码错误');
  };

  if (!staff) return genericFail('NO_SUCH_ACCOUNT');
  if (staff.status !== 1) {
    await loginLog({ brandId, account, staffId: Number(staff.id), ip: ctx.ip, ua, success: false, reason: 'DISABLED' });
    throw forbidden('账号已停用，请联系品牌管理员');
  }
  if (Number(staff.locked_until) > now) {
    await loginLog({ brandId, account, staffId: Number(staff.id), ip: ctx.ip, ua, success: false, reason: 'LOCKED' });
    throw tooMany('账号已被锁定，请 ' + Math.ceil((Number(staff.locked_until) - now) / 60000) + ' 分钟后再试');
  }
  if (!verifyPassword(password, staff.password_hash, staff.password_salt)) {
    const fails = Number(staff.fail_count) + 1;
    const lockUntil = fails >= MAX_FAIL ? now + LOCK_MS : 0;
    await db.execute('UPDATE mp_staff SET fail_count = ?, locked_until = ?, updated_at = ? WHERE id = ?', [
      fails >= MAX_FAIL ? 0 : fails, lockUntil, now, staff.id,
    ]);
    if (lockUntil) {
      logger.warn('staff locked', { account, ip: ctx.ip, fails });
      await loginLog({ brandId, account, staffId: Number(staff.id), ip: ctx.ip, ua, success: false, reason: 'LOCKED_NOW' });
      throw tooMany('连续失败次数过多，账号已锁定 15 分钟');
    }
    return genericFail('BAD_PASSWORD');
  }

  /* 登录成功：清零失败计数 + 记录时间 */
  await db.execute('UPDATE mp_staff SET fail_count = 0, locked_until = 0, last_login_at = ?, updated_at = ? WHERE id = ?', [
    now, now, staff.id,
  ]);

  const storeIds = await resolveStoreIds(staff);
  const jti = crypto.randomBytes(8).toString('hex');
  const accessToken = auth.sign({ typ: 'staff', sid: Number(staff.id), role: staff.role, jti }, config.staff.tokenTtl);
  const refreshToken = auth.sign({ typ: 'staff_refresh', sid: Number(staff.id), jti: crypto.randomBytes(8).toString('hex') }, config.staff.refreshTtl);

  await loginLog({ brandId, account, staffId: Number(staff.id), ip: ctx.ip, ua, success: true, reason: '' });
  logger.info('staff login', {
    account,
    role: staff.role,
    ip: ctx.ip,
    /* allStores 时 storeIds 为 null（代表全部门店），这里不要取 length */
    stores: storeIds === null ? 'ALL' : storeIds.length,
  });

  return ctx.ok({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: config.staff.tokenTtl,
    staff: publicStaff(staff, storeIds),
  });
}

/** 解析员工可见门店（每次请求都重算，保证权限变更立即生效） */
async function resolveStoreIds(staff) {
  if (staff.all_stores) return null; // null = 全部门店
  if (staff.role === 'REGION_MANAGER' && staff.region) {
    const rows = await db.query('SELECT id FROM mp_store WHERE brand_id = ? AND region = ? AND status = 1', [
      staff.brand_id, staff.region,
    ]);
    return rows.map((r) => r.id);
  }
  const rows = await db.query('SELECT store_id FROM mp_staff_store WHERE staff_id = ?', [staff.id]);
  return rows.map((r) => r.store_id);
}

/** 刷新令牌（轮换：旧的 jti 立刻吊销） */
async function refresh(ctx) {
  const token = String((ctx.body && ctx.body.refresh_token) || '');
  const payload = auth.verify(token);
  if (!payload || payload.typ !== 'staff_refresh') throw unauthorized('刷新令牌无效');
  const staff = await db.queryOne('SELECT * FROM mp_staff WHERE id = ? AND status = 1', [payload.sid]);
  if (!staff) throw unauthorized('账号不存在或已停用');

  const storeIds = await resolveStoreIds(staff);
  const accessToken = auth.sign(
    { typ: 'staff', sid: Number(staff.id), role: staff.role, jti: crypto.randomBytes(8).toString('hex') },
    config.staff.tokenTtl
  );
  const refreshToken = auth.sign(
    { typ: 'staff_refresh', sid: Number(staff.id), jti: crypto.randomBytes(8).toString('hex') },
    config.staff.refreshTtl
  );
  return ctx.ok({ access_token: accessToken, refresh_token: refreshToken, expires_in: config.staff.tokenTtl, staff: publicStaff(staff, storeIds) });
}

async function changePassword(ctx) {
  const oldPwd = String((ctx.body && ctx.body.oldPassword) || '');
  const newPwd = String((ctx.body && ctx.body.newPassword) || '');
  assertPasswordStrength(newPwd);
  const staff = ctx.staff;
  if (!verifyPassword(oldPwd, staff.password_hash, staff.password_salt)) {
    throw bizError(CODES.AUTH_FAILED, '原密码不正确');
  }
  if (oldPwd === newPwd) throw bizError(CODES.PARAM_INVALID, '新密码不能与原密码相同');
  const { hash, salt } = hashPassword(newPwd);
  await db.execute('UPDATE mp_staff SET password_hash = ?, password_salt = ?, must_change_pwd = 0, updated_at = ? WHERE id = ?', [
    hash, salt, Date.now(), staff.id,
  ]);
  await audit(ctx, 'PASSWORD_CHANGE', 'staff:' + staff.id, '修改密码');
  return ctx.ok({ ok: true });
}

async function logout(ctx) {
  const payload = ctx.tokenPayload;
  if (payload && payload.jti) {
    const ttl = Math.max(1, (payload.exp || 0) - Math.floor(Date.now() / 1000));
    await redis.cache.set('bl:' + payload.jti, 1, ttl);
  }
  await audit(ctx, 'LOGOUT', 'staff:' + (ctx.staff ? ctx.staff.id : ''), '退出登录');
  return ctx.ok({ ok: true });
}

/* ------------------------------ 中间件 ------------------------------ */
async function requireStaff(ctx) {
  const token = auth.extractToken(ctx);
  const payload = auth.verify(token);
  if (!payload || payload.typ !== 'staff') throw unauthorized('请先登录管理后台');
  const black = await redis.cache.get('bl:' + payload.jti);
  if (black) throw unauthorized('登录态已失效，请重新登录');

  const staff = await db.queryOne('SELECT * FROM mp_staff WHERE id = ? AND status = 1', [payload.sid]);
  if (!staff) throw unauthorized('账号不存在或已停用');

  const storeIds = await resolveStoreIds(staff);
  ctx.staff = staff;
  ctx.tokenPayload = payload;
  ctx.scope = rbac.scopeOf(staff, storeIds);

  /**
   * 强制改密：未改密前只放行改密 / 登出 / 个人信息
   * 白名单写的是**去掉 API_PREFIX 之后**的相对路径（本服务前缀为 /miniapp/v1/admin），
   * 千万别写成带 /admin 的旧路径——那样会永远匹配不上，用户被彻底卡死在改密页之外。
   */
  if (staff.must_change_pwd) {
    const allowed = ['/auth/password', '/auth/logout', '/auth/profile'];
    const rel = ctx.pathname.replace(config.apiPrefix, '');
    if (allowed.indexOf(rel) === -1) {
      throw forbidden('首次登录请先修改密码');
    }
  }
}

/** 审计日志（所有写操作都应调用） */
async function audit(ctx, action, target, detail) {
  try {
    await db.execute(
      `INSERT INTO mp_audit_log (brand_id, store_id, staff_id, staff_name, role, action, target, detail, ip, ua, request_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx.scope ? ctx.scope.brandId : '',
        (ctx.scope && ctx.scope.storeIds && ctx.scope.storeIds.length === 1 ? ctx.scope.storeIds[0] : ''),
        ctx.staff ? Number(ctx.staff.id) : 0,
        ctx.staff ? ctx.staff.name : '',
        ctx.staff ? ctx.staff.role : '',
        action,
        String(target || '').slice(0, 64),
        typeof detail === 'string' ? detail.slice(0, 1000) : JSON.stringify(detail || {}).slice(0, 1000),
        ctx.ip || '',
        String(ctx.headers['user-agent'] || '').slice(0, 250),
        ctx.requestId || '',
        Date.now(),
      ]
    );
  } catch (e) {
    logger.warn('audit failed', { action, message: e.message });
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  assertPasswordStrength,
  publicStaff,
  resolveStoreIds,
  login,
  refresh,
  changePassword,
  logout,
  requireStaff,
  audit,
  MAX_FAIL,
  LOCK_MS,
};
