/**
 * JWT 工具（管理系统后端）
 *
 * ── 与小程序后端的关系 ──
 * 两侧使用**同一个 JWT_SECRET**（配置同名同值），但令牌的 `typ` 不同：
 *   小程序端：`{uid, openid}` / `{typ:'refresh'}`
 *   管理端  ：`{typ:'staff', sid, role, jti}` / `{typ:'staff_refresh'}`
 * `requireStaff` 会校验 `typ === 'staff'`，所以**小程序令牌无法登录管理端**，反之亦然。
 *
 * 这里只实现员工令牌需要的签名/校验/提取，不复制小程序端的用户体系。
 */
const crypto = require('crypto');
const config = require('./config');

function b64u(bufOrStr) {
  const buf = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(String(bufOrStr), 'utf8');
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function sign(payload, ttlSec) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign(
    { iat: now, exp: now + (ttlSec || config.staff.tokenTtl), jti: crypto.randomBytes(8).toString('hex') },
    payload
  );
  const p1 = b64u(JSON.stringify(header));
  const p2 = b64u(JSON.stringify(body));
  const sig = b64u(crypto.createHmac('sha256', config.jwtSecret).update(p1 + '.' + p2).digest());
  return p1 + '.' + p2 + '.' + sig;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expect = b64u(crypto.createHmac('sha256', config.jwtSecret).update(parts[0] + '.' + parts[1]).digest());
  /* 定长比较，避免时序侧信道 */
  const a = Buffer.from(String(expect), 'utf8');
  const b = Buffer.from(String(parts[2]), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch (e) {
    return null;
  }
}

/** 从 Authorization: Bearer xxx 提取 */
function extractToken(ctx) {
  const h = String((ctx.headers && ctx.headers.authorization) || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

module.exports = { sign, verify, extractToken };
