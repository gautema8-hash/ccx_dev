/**
 * 登录 / 用户 / 优惠券 / 发票
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const auth = require('../auth');
const redis = require('../redis');
const config = require('../config');
const logger = require('../logger');
const wechat = require('../wechat');
const { bizError, notFound, unauthorized, tooMany, CODES } = require('../errors');

/** 上传根目录（生产建议换对象存储，这里给出可直接跑通的本地实现） */
const UPLOAD_ROOT = path.resolve(__dirname, '../../uploads');

/* ============================================================ 登录 */
async function login(ctx) {
  const code = String((ctx.body && ctx.body.code) || '').slice(0, 128);
  if (!code) throw bizError(CODES.PARAM_INVALID, '缺少 code');

  /**
   * 登录限流：按 IP 计数。
   * 阈值必须放宽到 300/分钟 —— 餐厅 WiFi 是 NAT 出口，全场顾客共用一个公网 IP，
   * 卡到 30/分钟会把整店顾客一起锁在门外（这是实测踩到的坑）。
   * 真正的防刷靠「code 一次性 + 短时效」，不是靠 IP 严限。
   */
  const r = await redis.rateLimit.hit('login:' + ctx.ip, 300, 60);
  if (!r.allowed) throw tooMany('登录过于频繁，请稍后再试');

  const sess = await wechat.code2session(code);
  const user = await auth.upsertUserByOpenid(sess.openid, sess.unionid);

  /* session_key 只在需要解密手机号时用，放 Redis 7 天，不落库 */
  if (sess.session_key) {
    await redis.cache.set('sk:' + user.id, sess.session_key, 7 * 24 * 3600);
  }

  const accessToken = auth.sign({ uid: user.id, openid: user.openid }, config.jwtTtl);
  const refreshToken = auth.sign({ uid: user.id, typ: 'refresh' }, config.refreshTtl);

  return ctx.ok({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: config.jwtTtl,
    user: auth.publicUser(user),
  });
}

async function refresh(ctx) {
  const token = String((ctx.body && ctx.body.refresh_token) || '');
  const payload = auth.verify(token);
  if (!payload || payload.typ !== 'refresh') throw unauthorized('refresh_token 无效');
  const user = await auth.loadUser(payload.uid);
  if (!user) throw unauthorized('账号不存在或已停用');
  return ctx.ok({ access_token: auth.sign({ uid: user.id, openid: user.openid }, config.jwtTtl), user: auth.publicUser(user) });
}

async function logout(ctx) {
  await auth.logout(ctx.tokenPayload);
  return ctx.ok({ ok: true });
}

/* ============================================================ 用户资料 */
async function me(ctx) {
  return ctx.ok(auth.publicUser(ctx.user));
}

async function updateProfile(ctx) {
  const b = ctx.body || {};
  const fields = [];
  const values = [];
  if (typeof b.nickname === 'string' && b.nickname.trim()) {
    fields.push('nickname = ?');
    values.push(b.nickname.trim().slice(0, 32));
  }
  if (typeof b.avatar === 'string' && b.avatar) {
    /* 只接受 https 或本站路径，杜绝 javascript:/data: 注入 */
    if (!/^(https:\/\/|\/)/.test(b.avatar)) throw bizError(CODES.PARAM_INVALID, '头像地址不合法');
    fields.push('avatar = ?');
    values.push(b.avatar.slice(0, 500));
  }
  /* ---- 个人资料扩展（「我的 → 个人资料」）---- */
  if (b.gender !== undefined && b.gender !== '') {
    const g = Number(b.gender);
    if ([0, 1, 2].indexOf(g) === -1) throw bizError(CODES.PARAM_INVALID, '性别取值不合法');
    fields.push('gender = ?');
    values.push(g);
  }
  if (typeof b.birthday === 'string' && b.birthday) {
    const bd = b.birthday.trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bd);
    if (!m) throw bizError(CODES.PARAM_INVALID, '生日格式应为 YYYY-MM-DD');
    const d = new Date(bd + 'T00:00:00');
    const valid = !isNaN(d.getTime()) && d.getFullYear() === Number(m[1]) && d.getMonth() + 1 === Number(m[2]) && d.getDate() === Number(m[3]);
    if (!valid) throw bizError(CODES.PARAM_INVALID, '生日不是有效日期');
    if (Number(m[1]) < 1900) throw bizError(CODES.PARAM_INVALID, '生日年份不合法');
    if (d.getTime() > Date.now()) throw bizError(CODES.PARAM_INVALID, '生日不能晚于今天');
    fields.push('birthday = ?');
    values.push(bd);
  }
  if (typeof b.city === 'string' && b.city.trim()) {
    fields.push('city = ?');
    values.push(b.city.trim().slice(0, 64));
  }
  if (!fields.length) throw bizError(CODES.PARAM_INVALID, '没有需要更新的字段');
  fields.push('updated_at = ?');
  values.push(Date.now());
  values.push(ctx.user.id);
  await db.execute(`UPDATE mp_user SET ${fields.join(', ')} WHERE id = ?`, values);
  await auth.invalidateUser(ctx.user.id);
  const user = await db.queryOne('SELECT * FROM mp_user WHERE id = ?', [ctx.user.id]);
  return ctx.ok(auth.publicUser(user));
}

/** 手机号快速验证：用 session_key 做 AES-128-CBC 解密 */
async function bindPhone(ctx) {
  const b = ctx.body || {};
  if (config.wx.loginMode !== 'real') {
    await db.execute('UPDATE mp_user SET phone = ?, updated_at = ? WHERE id = ?', ['13800000000', Date.now(), ctx.user.id]);
    await auth.invalidateUser(ctx.user.id);
    return ctx.ok({ phoneMask: '138****0000' });
  }
  const sk = await redis.cache.get('sk:' + ctx.user.id);
  if (!sk) throw bizError(CODES.AUTH_FAILED, '登录态已过期，请重新进入小程序');
  if (!b.encryptedData || !b.iv) throw bizError(CODES.PARAM_INVALID, '缺少手机号密文');
  let phone;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(sk, 'base64'), Buffer.from(b.iv, 'base64'));
    decipher.setAutoPadding(true);
    const plain = decipher.update(b.encryptedData, 'base64', 'utf8') + decipher.final('utf8');
    const data = JSON.parse(plain);
    /* watermark 校验：确保数据确实来自本小程序 */
    if (!data.watermark || data.watermark.appid !== config.wx.appid) {
      throw new Error('watermark 校验失败');
    }
    phone = data.phoneNumber || data.purePhoneNumber;
  } catch (e) {
    logger.warn('phone decrypt failed', { message: e.message });
    throw bizError(CODES.PARAM_INVALID, '手机号解密失败，请重试');
  }
  if (!phone) throw bizError(CODES.PARAM_INVALID, '未获取到手机号');
  await db.execute('UPDATE mp_user SET phone = ?, updated_at = ? WHERE id = ?', [phone, Date.now(), ctx.user.id]);
  await auth.invalidateUser(ctx.user.id);
  return ctx.ok({ phoneMask: phone.slice(0, 3) + '****' + phone.slice(-4) });
}

async function stats(ctx) {
  /* 积分/等级这类「会变且用户会盯」的字段直接读库，不吃 60s 用户缓存 */
  const row = await db.queryOne(
    `SELECT
       (SELECT COUNT(*) FROM mp_order WHERE user_id = ?) AS orderCount,
       (SELECT COUNT(*) FROM mp_order WHERE user_id = ? AND status NOT IN ('DONE','CANCELED')) AS ongoingCount,
       (SELECT COUNT(*) FROM mp_user_coupon WHERE user_id = ? AND status = 'UNUSED') AS couponCount,
       (SELECT points FROM mp_user WHERE id = ?) AS points,
       (SELECT member_level FROM mp_user WHERE id = ?) AS memberLevel,
       (SELECT member_name FROM mp_user WHERE id = ?) AS memberName`,
    [ctx.user.id, ctx.user.id, ctx.user.id, ctx.user.id, ctx.user.id, ctx.user.id]
  );
  return ctx.ok({
    orderCount: Number(row.orderCount),
    ongoingCount: Number(row.ongoingCount),
    couponCount: Number(row.couponCount),
    points: Number(row.points || 0),
    memberLevel: Number(row.memberLevel || 1),
    memberName: row.memberName || '铜签会员',
  });
}

/* ============================================================ 账号注销 ============================================================ */
/**
 * 注销账号（「我的 → 账号设置」）
 *
 * 合规要点：
 *   · 用户协议已明示「注销后不可恢复，历史订单与优惠券一并作废」，这里按此执行
 *   · openid 会被改名释放（del_<id>_<rand>），下次用同一微信进入即全新账号，
 *     避免「注销后仍能凭旧 openid 找回历史数据」的假注销
 *   · 注销留痕只存 openid 的 SHA-256，不保留明文
 *   · 有进行中订单 / 未结退款时拒绝注销 —— 否则履约与资金会对不上账
 */
async function cancelAccount(ctx) {
  const reason = String((ctx.body && ctx.body.reason) || '').slice(0, 200);

  const ongoing = await db.queryOne(
    "SELECT COUNT(*) AS c FROM mp_order WHERE user_id = ? AND status NOT IN ('DONE','CANCELED')",
    [ctx.user.id]
  );
  if (Number(ongoing.c) > 0) {
    throw bizError(CODES.STATE_CONFLICT, '你有进行中的订单，请完成或取消后再注销账号');
  }
  const refunding = await db.queryOne(
    "SELECT COUNT(*) AS c FROM mp_refund r JOIN mp_order o ON o.id = r.order_id WHERE o.user_id = ? AND r.status IN ('APPLIED','APPROVED')",
    [ctx.user.id]
  );
  if (Number(refunding.c) > 0) {
    throw bizError(CODES.STATE_CONFLICT, '你有正在处理中的退款申请，请等待处理完成后再注销');
  }

  const now = Date.now();
  const openidHash = crypto.createHash('sha256').update(String(ctx.user.openid || '')).digest('hex');
  await db.execute(
    `UPDATE mp_user
     SET status = 0, cancel_at = ?, openid = ?, unionid = '', nickname = '已注销用户', avatar = '', phone = '',
         gender = 0, birthday = '', city = '', points = 0, updated_at = ?
     WHERE id = ?`,
    [now, 'del_' + ctx.user.id + '_' + crypto.randomBytes(4).toString('hex'), now, ctx.user.id]
  );
  await db.execute('INSERT INTO mp_user_cancel_log (user_id, openid_hash, reason, created_at) VALUES (?,?,?,?)', [
    ctx.user.id,
    openidHash,
    reason,
    now,
  ]);
  /* 未使用的券全部作废（已使用的保留，用于对账） */
  await db.execute("UPDATE mp_user_coupon SET status = 'EXPIRED' WHERE user_id = ? AND status = 'UNUSED'", [ctx.user.id]);
  /* 地址簿等个人数据直接删除 */
  await db.execute('DELETE FROM mp_address WHERE user_id = ?', [ctx.user.id]);
  await db.execute("UPDATE mp_service_ticket SET status = 'CLOSED', updated_at = ? WHERE user_id = ? AND status = 'OPEN'", [now, ctx.user.id]);

  await auth.invalidateUser(ctx.user.id);
  await auth.logout(ctx.tokenPayload);
  logger.info('account canceled', { uid: ctx.user.id });
  return ctx.ok({ ok: true, cancelAt: now });
}

/* ============================================================ 头像上传 */
const AVATAR_MAX = 300 * 1024;

async function uploadAvatar(ctx) {
  const b = ctx.body || {};
  const base64 = String(b.base64 || '');
  if (!base64) throw bizError(CODES.PARAM_INVALID, '缺少头像数据');
  let buf;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch (e) {
    throw bizError(CODES.PARAM_INVALID, '头像数据格式错误');
  }
  if (!buf.length) throw bizError(CODES.PARAM_INVALID, '头像数据为空');
  if (buf.length > AVATAR_MAX) throw bizError(CODES.PARAM_INVALID, '头像过大，请压缩后重试');

  /* 魔数校验：只认 JPG / PNG，避免把任意文件写进可访问目录（存储型 XSS 的常见入口） */
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isJpg && !isPng) throw bizError(CODES.PARAM_INVALID, '只支持 JPG / PNG 图片');

  const ext = isPng ? 'png' : 'jpg';
  const dir = path.join(UPLOAD_ROOT, 'avatars');
  fs.mkdirSync(dir, { recursive: true });
  const name = 'u' + ctx.user.id + '_' + Date.now() + '.' + ext;
  fs.writeFileSync(path.join(dir, name), buf);

  const url = '/uploads/avatars/' + name;
  await db.execute('UPDATE mp_user SET avatar = ?, updated_at = ? WHERE id = ?', [url, Date.now(), ctx.user.id]);
  await auth.invalidateUser(ctx.user.id);
  logger.info('avatar uploaded', { uid: ctx.user.id, size: buf.length, ext });
  return ctx.ok({ url });
}

/** 静态资源：只允许 /uploads/ 下的白名单文件名，防目录穿越 */
function serveUpload(ctx) {
  const rel = decodeURIComponent(ctx.pathname.replace(/^\/uploads\//, ''));
  if (!rel || rel.indexOf('..') > -1 || rel.indexOf('\\') > -1 || rel.charAt(0) === '/') {
    return ctx.send(400, { code: CODES.PARAM_INVALID, message: '非法路径', data: null });
  }
  const file = path.resolve(UPLOAD_ROOT, rel);
  if (file.indexOf(UPLOAD_ROOT) !== 0 || !fs.existsSync(file)) {
    return ctx.send(404, { code: CODES.NOT_FOUND, message: '文件不存在', data: null });
  }
  const data = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const type =
    ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
  ctx.sent = true;
  ctx.res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    /* 用户上传目录是典型的存储型 XSS 落点：必须 nosniff + 禁止被嵌入 */
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Frame-Options': 'DENY',
  });
  ctx.res.end(data);
}

/* ============================================================ 优惠券 */
async function coupons(ctx) {
  const status = ctx.query.status === 'all' ? null : ctx.query.status || 'UNUSED';
  const params = [ctx.user.id];
  let where = 'uc.user_id = ?';
  if (status) {
    where += ' AND uc.status = ?';
    params.push(status);
  }
  const rows = await db.query(
    `SELECT c.id, c.name, c.type, c.value, c.threshold, c.scope, c.expire_at, uc.status AS userStatus
     FROM mp_user_coupon uc JOIN mp_coupon c ON c.id = uc.coupon_id
     WHERE ${where} ORDER BY uc.got_at DESC`,
    params
  );
  return ctx.ok(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      value: Number(r.value),
      threshold: Number(r.threshold),
      scope: r.scope,
      expireAt: r.expire_at,
      usable: r.userStatus === 'UNUSED',
    }))
  );
}

/* ============================================================ 发票抬头 */
async function listInvoice(ctx) {
  const rows = await db.query('SELECT * FROM mp_invoice WHERE user_id = ? ORDER BY is_default DESC, id DESC', [ctx.user.id]);
  return ctx.ok(
    rows.map((r) => ({
      id: r.id,
      titleType: r.title_type,
      title: r.title,
      taxNo: r.tax_no,
      email: r.email,
      isDefault: !!r.is_default,
    }))
  );
}

async function saveInvoice(ctx) {
  const b = ctx.body || {};
  const title = String(b.title || '').trim().slice(0, 128);
  if (!title) throw bizError(CODES.PARAM_INVALID, '请填写发票抬头');
  const titleType = b.titleType === 'company' ? 'company' : 'personal';
  const taxNo = String(b.taxNo || '').trim().slice(0, 64);
  if (titleType === 'company' && !/^[0-9A-Z]{15,20}$/.test(taxNo)) {
    throw bizError(CODES.PARAM_INVALID, '纳税人识别号格式不正确');
  }
  const count = await db.queryOne('SELECT COUNT(*) AS c FROM mp_invoice WHERE user_id = ?', [ctx.user.id]);
  if (Number(count.c) >= 10) throw bizError(CODES.PARAM_INVALID, '最多保存 10 个抬头');
  const r = await db.execute(
    'INSERT INTO mp_invoice (user_id, title_type, title, tax_no, email, is_default, created_at) VALUES (?,?,?,?,?,?,?)',
    [ctx.user.id, titleType, title, taxNo, String(b.email || '').slice(0, 128), Number(count.c) === 0 ? 1 : 0, Date.now()]
  );
  return ctx.ok({ id: r.insertId });
}

async function deleteInvoice(ctx) {
  const r = await db.execute('DELETE FROM mp_invoice WHERE id = ? AND user_id = ?', [ctx.params.id, ctx.user.id]);
  if (r.affectedRows === 0) throw notFound('抬头不存在');
  return ctx.ok({ ok: true });
}

module.exports = {
  login,
  refresh,
  logout,
  me,
  updateProfile,
  bindPhone,
  cancelAccount,
  stats,
  coupons,
  uploadAvatar,
  serveUpload,
  listInvoice,
  saveInvoice,
  deleteInvoice,
};
