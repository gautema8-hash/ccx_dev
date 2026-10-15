/**
 * 鉴权：自签 JWT（HS256，零依赖）+ 鉴权中间件 + 用户建档
 *
 * 交付级要点：
 *   · 签名比较用 timingSafeEqual，避免时序侧信道
 *   · token 带 jti，退出登录把 jti 写入 Redis 黑名单（Redis 不可用时降级为短期 token 自然过期）
 *   · 用户信息走 Redis 缓存 60s，避免每个请求都查库
 *   · 越权防护：所有「按 id 取订单」的接口都必须带 user_id 条件，不接受「先查再判断」
 */
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const redis = require('./redis');
const { unauthorized, bizError, CODES } = require('./errors');

/* ------------------------------ JWT ------------------------------ */
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDecode = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function sign(payload, ttlSec) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign({ iat: now, exp: now + (ttlSec || config.jwtTtl), jti: crypto.randomBytes(8).toString('hex') }, payload);
  const p1 = b64u(JSON.stringify(header));
  const p2 = b64u(JSON.stringify(body));
  const sig = b64u(crypto.createHmac('sha256', config.jwtSecret).update(p1 + '.' + p2).digest());
  return p1 + '.' + p2 + '.' + sig;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [p1, p2, sig] = parts;
  const expect = b64u(crypto.createHmac('sha256', config.jwtSecret).update(p1 + '.' + p2).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(b64uDecode(p2));
  } catch (e) {
    return null;
  }
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

/* ------------------------------ 用户 ------------------------------ */
function publicUser(u) {
  return {
    id: u.id,
    openid: u.openid,
    nickname: u.nickname,
    avatar: u.avatar,
    phoneMask: u.phone ? u.phone.slice(0, 3) + '****' + u.phone.slice(-4) : '',
    phoneBound: !!u.phone,
    /** 个人资料扩展字段（「我的 → 个人资料」） */
    gender: Number(u.gender || 0),
    birthday: u.birthday || '',
    city: u.city || '',
    memberLevel: u.member_level,
    memberName: u.member_name,
    points: u.points,
    registerAt: Number(u.created_at),
  };
}

/** 按 openid 建档 / 更新登录时间（幂等） */
async function upsertUserByOpenid(openid, unionid) {
  const now = Date.now();
  let user = await db.queryOne('SELECT * FROM mp_user WHERE openid = ?', [openid]);
  if (!user) {
    // 并发首登：靠 uk_openid 唯一键兜底，冲突后重查
    try {
      const r = await db.execute(
        'INSERT INTO mp_user (openid, unionid, nickname, avatar, phone, member_level, member_name, points, status, created_at, updated_at, last_login_at) VALUES (?,?,?,?,?,1,?,0,1,?,?,?)',
        [openid, unionid || '', '串串香食客', '', '', '铜签会员', now, now, now]
      );
      user = await db.queryOne('SELECT * FROM mp_user WHERE id = ?', [r.insertId]);
    } catch (e) {
      if (e && e.errno === 1062) {
        user = await db.queryOne('SELECT * FROM mp_user WHERE openid = ?', [openid]);
      } else {
        throw e;
      }
    }
    await grantNewUserCoupons(user.id);
  } else {
    await db.execute('UPDATE mp_user SET last_login_at = ?, updated_at = ? WHERE id = ?', [now, now, user.id]);
    user.last_login_at = now;
  }
  return user;
}

/** 新客自动发券（规则在 mp_coupon.issue_type = 'NEW_USER'，可视化配置，无需改代码） */
async function grantNewUserCoupons(userId) {
  try {
    const couponService = require('./couponService');
    return await couponService.grantNewUserCoupons(userId, 'brand_lbz');
  } catch (e) {
    logger.warn('grant new user coupons failed', { userId, message: e.message });
    return [];
  }
}

async function loadUser(userId) {
  const cacheKey = 'u:' + userId;
  const cached = await redis.cache.get(cacheKey);
  if (cached) return cached;
  const u = await db.queryOne('SELECT * FROM mp_user WHERE id = ? AND status = 1', [userId]);
  if (u) await redis.cache.set(cacheKey, u, 60);
  return u;
}
async function invalidateUser(userId) {
  await redis.cache.del('u:' + userId);
}

/* ------------------------------ 中间件 ------------------------------ */
function extractToken(ctx) {
  const h = ctx.headers['authorization'] || ctx.headers['Authorization'] || '';
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  return '';
}

/** 强制登录：失败抛 401（客户端会静默重登并重放一次） */
async function requireAuth(ctx) {
  const token = extractToken(ctx);
  const payload = verify(token);
  if (!payload || !payload.uid) throw unauthorized('登录态已失效，请重新进入小程序');
  const black = await redis.cache.get('bl:' + payload.jti);
  if (black) throw unauthorized('登录态已失效，请重新进入小程序');
  const user = await loadUser(payload.uid);
  if (!user) throw unauthorized('账号不存在或已停用');
  ctx.user = user;
  ctx.tokenPayload = payload;
}

/** 可选登录：有 token 就带上用户，没有也放行 */
async function optionalAuth(ctx) {
  const token = extractToken(ctx);
  const payload = verify(token);
  if (payload && payload.uid) {
    const user = await loadUser(payload.uid);
    if (user) {
      ctx.user = user;
      ctx.tokenPayload = payload;
    }
  }
}

async function logout(tokenPayload) {
  if (!tokenPayload || !tokenPayload.jti) return;
  const ttl = Math.max(1, (tokenPayload.exp || 0) - Math.floor(Date.now() / 1000));
  await redis.cache.set('bl:' + tokenPayload.jti, 1, ttl);
}

module.exports = {
  sign,
  verify,
  publicUser,
  upsertUserByOpenid,
  grantNewUserCoupons,
  loadUser,
  invalidateUser,
  requireAuth,
  optionalAuth,
  logout,
  extractToken,
};
