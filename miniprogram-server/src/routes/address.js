/**
 * 用户地址簿（「我的 → 地址管理」）
 *
 * 交付级约束：
 *   · 所有写操作都带 user_id 条件 —— 越权改别人的地址在 SQL 层就改不动
 *   · 默认地址在同一用户内唯一：设默认时先清后置，避免出现两个默认
 *   · 删除默认地址后自动把最近更新的一条升为默认，列表永远不会「没有默认」
 *   · 数据清洗（长度/手机号格式/地区）在服务端做，客户端校验只作为体验优化
 */
const db = require('../db');
const redis = require('../redis');
const { bizError, notFound, tooMany, CODES } = require('../errors');

const MAX_ADDRESS = 20;
const PHONE_RE = /^1[3-9]\d{9}$/;
const TAGS = ['家', '公司', '学校'];

/** 文本清洗：去首尾空白 + 折叠连续空白 + 截断 */
function clean(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 校验并归一化地址入参（create/update 共用） */
function normalize(body) {
  const b = body || {};
  const name = clean(b.name, 20);
  const phone = clean(b.phone, 20).replace(/[-\s]/g, '');
  /* 地区：兼容 [省,市,区] 数组 / '省 市 区' 字符串 / 三个独立字段 */
  let province = clean(b.province, 32);
  let city = clean(b.city, 32);
  let district = clean(b.district, 32);
  if ((!province || !city) && b.region) {
    const arr = Array.isArray(b.region) ? b.region : String(b.region).split(/[\s/]+/);
    province = province || clean(arr[0], 32);
    city = city || clean(arr[1], 32);
    district = district || clean(arr[2], 32);
  }
  const detail = clean(b.detail, 200);
  const tag = TAGS.indexOf(clean(b.tag, 8)) > -1 ? clean(b.tag, 8) : '';

  if (name.length < 2) throw bizError(CODES.PARAM_INVALID, '请填写 2-20 字的联系人姓名');
  if (!PHONE_RE.test(phone)) throw bizError(CODES.PARAM_INVALID, '手机号格式不正确');
  if (!province || !city) throw bizError(CODES.PARAM_INVALID, '请选择所在地区');
  if (detail.length < 5) throw bizError(CODES.PARAM_INVALID, '详细地址不少于 5 个字（楼栋 / 门牌 / 房号）');

  return { name, phone, province, city, district, detail, tag, isDefault: b.isDefault ? 1 : 0 };
}

function dto(r) {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    phoneMask: r.phone ? r.phone.slice(0, 3) + '****' + r.phone.slice(-4) : '',
    province: r.province,
    city: r.city,
    district: r.district,
    regionText: [r.province, r.city, r.district].filter(Boolean).join(' '),
    detail: r.detail,
    tag: r.tag,
    isDefault: !!r.is_default,
    updatedAt: Number(r.updated_at),
  };
}

/** 地址列表（默认地址置顶） */
async function list(ctx) {
  const rows = await db.query(
    'SELECT * FROM mp_address WHERE user_id = ? ORDER BY is_default DESC, updated_at DESC LIMIT ?',
    [ctx.user.id, MAX_ADDRESS]
  );
  return ctx.ok({ list: rows.map(dto), total: rows.length });
}

async function create(ctx) {
  const rl = await redis.rateLimit.hit('address:' + ctx.user.id, 30, 60);
  if (!rl.allowed) throw tooMany('操作过于频繁，请稍后再试');

  const f = normalize(ctx.body);
  const cnt = await db.queryOne('SELECT COUNT(*) AS c FROM mp_address WHERE user_id = ?', [ctx.user.id]);
  if (Number(cnt.c) >= MAX_ADDRESS) throw bizError(CODES.PARAM_INVALID, `最多保存 ${MAX_ADDRESS} 个地址`);

  const now = Date.now();
  /* 第一个地址自动设为默认：否则用户下单时无默认可选 */
  const isDefault = Number(cnt.c) === 0 ? 1 : f.isDefault;
  if (isDefault) {
    await db.execute('UPDATE mp_address SET is_default = 0 WHERE user_id = ?', [ctx.user.id]);
  }
  const r = await db.execute(
    `INSERT INTO mp_address (user_id, name, phone, province, city, district, detail, tag, is_default, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [ctx.user.id, f.name, f.phone, f.province, f.city, f.district, f.detail, f.tag, isDefault, now, now]
  );
  return ctx.ok({ id: r.insertId, isDefault: !!isDefault });
}

async function update(ctx) {
  const id = Number(ctx.params.id);
  const exist = await db.queryOne('SELECT * FROM mp_address WHERE id = ? AND user_id = ?', [id, ctx.user.id]);
  if (!exist) throw notFound('地址不存在');

  const f = normalize(ctx.body);
  const now = Date.now();
  if (f.isDefault) {
    await db.execute('UPDATE mp_address SET is_default = 0 WHERE user_id = ?', [ctx.user.id]);
  }
  await db.execute(
    `UPDATE mp_address SET name=?, phone=?, province=?, city=?, district=?, detail=?, tag=?, is_default=?, updated_at=?
     WHERE id = ? AND user_id = ?`,
    [f.name, f.phone, f.province, f.city, f.district, f.detail, f.tag, f.isDefault, now, id, ctx.user.id]
  );
  return ctx.ok({ ok: true });
}

async function remove(ctx) {
  const id = Number(ctx.params.id);
  const exist = await db.queryOne('SELECT * FROM mp_address WHERE id = ? AND user_id = ?', [id, ctx.user.id]);
  if (!exist) throw notFound('地址不存在');

  await db.execute('DELETE FROM mp_address WHERE id = ? AND user_id = ?', [id, ctx.user.id]);
  /* 删掉默认地址后补位，保证列表里始终有一个默认 */
  if (exist.is_default) {
    const next = await db.queryOne(
      'SELECT id FROM mp_address WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
      [ctx.user.id]
    );
    if (next) await db.execute('UPDATE mp_address SET is_default = 1, updated_at = ? WHERE id = ?', [Date.now(), next.id]);
  }
  return ctx.ok({ ok: true });
}

async function setDefault(ctx) {
  const id = Number(ctx.params.id);
  const exist = await db.queryOne('SELECT id FROM mp_address WHERE id = ? AND user_id = ?', [id, ctx.user.id]);
  if (!exist) throw notFound('地址不存在');
  await db.execute('UPDATE mp_address SET is_default = 0 WHERE user_id = ?', [ctx.user.id]);
  await db.execute('UPDATE mp_address SET is_default = 1, updated_at = ? WHERE id = ? AND user_id = ?', [Date.now(), id, ctx.user.id]);
  return ctx.ok({ ok: true });
}

module.exports = { list, create, update, remove, setDefault };
