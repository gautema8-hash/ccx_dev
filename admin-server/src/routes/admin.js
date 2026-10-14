/**
 * 管理端 API（连锁版）
 *
 * ── 三条铁律 ──
 *   1. 每个接口先过 requireStaff（身份）→ assertPerm（能不能做）→ assertStore/scope（能在哪家店做）
 *   2. 所有列表查询必须走 rbac.applyScope()，**不允许业务代码自己拼 store_id 条件**
 *   3. 所有写操作必须 staffAuth.audit() 留痕
 *
 * ── 数据隔离的实现方式 ──
 *   不是「查出来再判断」，而是**在 SQL 层就把范围过滤掉**（store_id IN (授权门店)）。
 *   前者一旦漏判就是数据泄露；后者最坏情况是查不到数据 —— 安全兜底方向正确。
 */
const db = require('../db');
const config = require('../config');
const logger = require('../logger');
const rbac = require('../rbac');
const staffAuth = require('../staffAuth');
const themeService = require('../themeService');
const couponService = require('../couponService');
const voucherQuery = require('../voucherQuery');
const { bizError, notFound, forbidden, CODES } = require('../errors');

const internalApi = require('../internalApi');
const { ORDER_STATUS, FLOW_ACTIONS } = require('../orderStatus');

/* ============================================================ 通用工具 */
function toInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}
function dayRange(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  return { start, end: start + 86400000 };
}
function pageArgs(q, defSize, maxSize) {
  return {
    page: Math.min(10000, Math.max(1, toInt(q.page, 1))),
    size: Math.min(maxSize || 100, Math.max(1, toInt(q.size, defSize || 30))),
  };
}
function authInvalidate(userId) {
  try {
    return require('../auth').invalidateUser(userId);
  } catch (e) {
    return Promise.resolve();
  }
}

/* ============================================================ 品牌 */
async function getBrand(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.STORE_READ);
  const brand = await db.queryOne('SELECT * FROM mp_brand WHERE id = ?', [ctx.scope.brandId]);
  if (!brand) throw notFound('品牌不存在');
  return ctx.ok({ id: brand.id, name: brand.name, logo: brand.logo, notice: brand.notice, contact: brand.contact, status: Number(brand.status) });
}

async function saveBrand(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.BRAND_WRITE);
  const b = ctx.body || {};
  const name = String(b.name || '').trim().slice(0, 128);
  if (!name) throw bizError(CODES.PARAM_INVALID, '请填写品牌名称');
  await db.execute('UPDATE mp_brand SET name = ?, logo = ?, notice = ?, contact = ?, updated_at = ? WHERE id = ?', [
    name, String(b.logo || '🌶️').slice(0, 8), String(b.notice || '').slice(0, 250), String(b.contact || '').slice(0, 64), Date.now(), ctx.scope.brandId,
  ]);
  await staffAuth.audit(ctx, 'BRAND_UPDATE', ctx.scope.brandId, { name });
  return ctx.ok({ ok: true });
}

/* ============================================================ 门店 */
async function listStores(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.STORE_READ);
  const { page, size } = pageArgs(ctx.query, 50, 200);
  const params = [ctx.scope.brandId];
  let where = 'WHERE brand_id = ?';
  if (ctx.query.type === 'DIRECT' || ctx.query.type === 'FRANCHISE') {
    where += ' AND type = ?';
    params.push(ctx.query.type);
  }
  if (ctx.query.keyword) {
    where += ' AND (name LIKE ? OR code LIKE ? OR city LIKE ? OR franchisee LIKE ?)';
    const kw = '%' + String(ctx.query.keyword).slice(0, 32) + '%';
    params.push(kw, kw, kw, kw);
  }
  const scoped = rbac.applyScope(where, params, ctx, 'id');
  if (scoped.empty) return ctx.ok({ list: [], total: 0, page, size });

  const total = await db.queryOne(`SELECT COUNT(*) AS c FROM mp_store ${scoped.where}`, scoped.params);
  const rows = await db.query(
    `SELECT * FROM mp_store ${scoped.where} ORDER BY type ASC, id ASC LIMIT ? OFFSET ?`,
    scoped.params.concat([size, (page - 1) * size])
  );

  const today = dayRange();
  const ids = rows.map((r) => r.id);
  let statMap = new Map();
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const stats = await db.query(
      `SELECT store_id, COUNT(*) AS orderCount,
              SUM(CASE WHEN status IN ('PAID','ACCEPTED','COOKING','READY','DONE') THEN pay_amount ELSE 0 END) AS revenue
       FROM mp_order WHERE store_id IN (${ph}) AND created_at >= ? AND created_at < ?
       GROUP BY store_id`,
      ids.concat([today.start, today.end])
    );
    statMap = new Map(stats.map((s) => [s.store_id, s]));
  }

  return ctx.ok({
    list: rows.map((s) => {
      const st = statMap.get(s.id) || {};
      return {
        id: s.id, brandId: s.brand_id, code: s.code, name: s.name,
        type: s.type, typeText: s.type === 'FRANCHISE' ? '加盟店' : '直营店',
        franchisee: s.franchisee, region: s.region, city: s.city, address: s.address, phone: s.phone,
        latitude: Number(s.latitude), longitude: Number(s.longitude),
        perCapita: Number(s.per_capita), openTime: s.open_time, status: Number(s.status),
        todayOrderCount: Number(st.orderCount || 0),
        todayRevenue: Number(st.revenue || 0),
        todayRevenueText: (Number(st.revenue || 0) / 100).toFixed(2),
      };
    }),
    total: Number(total.c),
    page,
    size,
  });
}

async function saveStore(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.STORE_WRITE);
  const b = ctx.body || {};
  const name = String(b.name || '').trim().slice(0, 128);
  if (!name) throw bizError(CODES.PARAM_INVALID, '请填写门店名称');
  const type = b.type === 'FRANCHISE' ? 'FRANCHISE' : 'DIRECT';
  if (type === 'FRANCHISE' && !String(b.franchisee || '').trim()) {
    throw bizError(CODES.PARAM_INVALID, '加盟店必须填写加盟商主体');
  }
  const lat = Number(b.latitude) || 0;
  const lng = Number(b.longitude) || 0;
  if (lat && (lat < -90 || lat > 90)) throw bizError(CODES.PARAM_INVALID, '纬度不合法');
  if (lng && (lng < -180 || lng > 180)) throw bizError(CODES.PARAM_INVALID, '经度不合法');
  const now = Date.now();

  if (b.id) {
    rbac.assertStore(ctx, b.id);
    const exist = await db.queryOne('SELECT id FROM mp_store WHERE id = ? AND brand_id = ?', [b.id, ctx.scope.brandId]);
    if (!exist) throw notFound('门店不存在');
    await db.execute(
      `UPDATE mp_store SET name=?, type=?, franchisee=?, region=?, city=?, address=?, phone=?,
         latitude=?, longitude=?, open_time=?, per_capita=?, updated_at=? WHERE id=? AND brand_id=?`,
      [name, type, String(b.franchisee || '').slice(0, 128), String(b.region || '').slice(0, 64), String(b.city || '').slice(0, 64),
       String(b.address || '').slice(0, 255), String(b.phone || '').slice(0, 32), lat, lng,
       String(b.openTime || '').slice(0, 64), Math.max(0, toInt(b.perCapita, 0)), now, b.id, ctx.scope.brandId]
    );
    await staffAuth.audit(ctx, 'STORE_UPDATE', b.id, { name, type });
    return ctx.ok({ id: b.id, updated: true });
  }

  const id = 'st_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  const code = String(b.code || 'S' + Date.now().toString().slice(-5)).slice(0, 32);
  await db.tx(async (tx) => {
    await tx.execute(
      `INSERT INTO mp_store (id, brand_id, code, name, type, franchisee, region, city, address, phone,
        latitude, longitude, open_time, per_capita, tables_json, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      [id, ctx.scope.brandId, code, name, type, String(b.franchisee || '').slice(0, 128), String(b.region || '').slice(0, 64),
       String(b.city || '').slice(0, 64), String(b.address || '').slice(0, 255), String(b.phone || '').slice(0, 32),
       lat, lng, String(b.openTime || '').slice(0, 64), Math.max(0, toInt(b.perCapita, 0)),
       JSON.stringify(b.tables || []), now, now]
    );
    /* 新店自动继承品牌菜单（库存默认 0，由门店自己决定什么时候开卖） */
    const dishes = await tx.query('SELECT id FROM mp_dish WHERE brand_id = ? AND status = 1', [ctx.scope.brandId]);
    for (const d of dishes) {
      await tx.execute('INSERT INTO mp_store_dish (store_id, dish_id, price_override, stock, sold, status, updated_at) VALUES (?,?,0,0,0,1,?)', [
        id, d.id, now,
      ]);
    }
    if (!ctx.scope.allStores) {
      await tx.execute('INSERT IGNORE INTO mp_staff_store (staff_id, store_id) VALUES (?,?)', [ctx.staff.id, id]);
    }
  });
  await staffAuth.audit(ctx, 'STORE_CREATE', id, { name, type, code });
  logger.info('store created', { id, name, type, by: ctx.staff.id });
  return ctx.ok({ id, code, created: true });
}

async function toggleStore(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.STORE_WRITE);
  const id = ctx.params.id;
  rbac.assertStore(ctx, id);
  const status = ctx.body && ctx.body.status ? 1 : 0;
  const r = await db.execute('UPDATE mp_store SET status = ?, updated_at = ? WHERE id = ? AND brand_id = ?', [
    status, Date.now(), id, ctx.scope.brandId,
  ]);
  if (r.affectedRows === 0) throw notFound('门店不存在');
  await staffAuth.audit(ctx, status ? 'STORE_OPEN' : 'STORE_CLOSE', id, {});
  return ctx.ok({ ok: true, status });
}

async function syncStoreMenu(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.DISH_WRITE);
  const storeId = ctx.params.id;
  rbac.assertStore(ctx, storeId);
  const dishes = await db.query('SELECT id FROM mp_dish WHERE brand_id = ? AND status = 1', [ctx.scope.brandId]);
  const exist = await db.query('SELECT dish_id FROM mp_store_dish WHERE store_id = ?', [storeId]);
  const existSet = new Set(exist.map((e) => e.dish_id));
  let added = 0;
  const now = Date.now();
  for (const d of dishes) {
    if (existSet.has(d.id)) continue;
    await db.execute('INSERT INTO mp_store_dish (store_id, dish_id, price_override, stock, sold, status, updated_at) VALUES (?,?,0,0,0,1,?)', [
      storeId, d.id, now,
    ]);
    added++;
  }
  await internalApi.invalidateMenuCache(storeId);
  await staffAuth.audit(ctx, 'STORE_MENU_SYNC', storeId, { added });
  return ctx.ok({ ok: true, added, total: dishes.length });
}

/* ============================================================ 员工 */
async function listStaff(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.STAFF_READ);
  const params = [ctx.scope.brandId];
  let where = 'WHERE brand_id = ?';
  if (ctx.query.role) {
    where += ' AND role = ?';
    params.push(String(ctx.query.role).slice(0, 32));
  }
  if (ctx.query.keyword) {
    where += ' AND (account LIKE ? OR name LIKE ?)';
    const kw = '%' + String(ctx.query.keyword).slice(0, 32) + '%';
    params.push(kw, kw);
  }
  const rows = await db.query(`SELECT * FROM mp_staff ${where} ORDER BY role ASC, id ASC`, params);
  const links = await db.query('SELECT staff_id, store_id FROM mp_staff_store');
  const map = new Map();
  links.forEach((l) => {
    if (!map.has(Number(l.staff_id))) map.set(Number(l.staff_id), []);
    map.get(Number(l.staff_id)).push(l.store_id);
  });
  const stores = await db.query('SELECT id, name FROM mp_store WHERE brand_id = ?', [ctx.scope.brandId]);
  const storeName = new Map(stores.map((s) => [s.id, s.name]));

  let list = rows.map((s) => {
    const ids = s.all_stores ? null : map.get(Number(s.id)) || [];
    return {
      id: Number(s.id), account: s.account, name: s.name, phone: s.phone,
      role: s.role, roleName: (rbac.roleMeta(s.role) || {}).name || s.role,
      region: s.region, allStores: !!s.all_stores,
      storeIds: ids || [],
      storeNames: ids ? ids.map((i) => storeName.get(i) || i) : ['全部门店'],
      status: Number(s.status), mustChangePwd: !!s.must_change_pwd,
      lastLoginAt: Number(s.last_login_at || 0),
      locked: Number(s.locked_until) > Date.now(),
    };
  });
  if (!ctx.scope.allStores) {
    const mine = new Set(ctx.scope.storeIds || []);
    list = list.filter((s) => {
      if (s.allStores) return s.role === 'REGION_MANAGER' && s.region === ctx.scope.region;
      return s.storeIds.some((i) => mine.has(i));
    });
  }
  return ctx.ok({ list, total: list.length, roles: rbac.roleOptions() });
}

async function saveStaff(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.STAFF_WRITE);
  const b = ctx.body || {};
  const account = String(b.account || '').trim().toLowerCase().slice(0, 64);
  const name = String(b.name || '').trim().slice(0, 64);
  const role = String(b.role || '');
  if (!rbac.roleMeta(role)) throw bizError(CODES.PARAM_INVALID, '角色不存在');
  if (role === 'BRAND_ADMIN' && ctx.scope.role !== 'BRAND_ADMIN') {
    throw forbidden('只有品牌超管可以创建/修改品牌超管账号');
  }

  /* 门店授权必须落在自己的范围内 —— 否则管理端可以给自己扩权 */
  let storeIds = Array.isArray(b.storeIds) ? b.storeIds.map(String).slice(0, 200) : [];
  if (role === 'REGION_MANAGER') storeIds = [];
  if (role === 'BRAND_ADMIN') storeIds = [];
  if (role !== 'BRAND_ADMIN') {
    if (!ctx.scope.allStores) {
      const mine = new Set(ctx.scope.storeIds || []);
      const bad = storeIds.filter((i) => !mine.has(i));
      if (bad.length) throw forbidden('不能把门店授权给自己无权管理的门店：' + bad.join(','));
    }
    if (role !== 'REGION_MANAGER' && !storeIds.length) throw bizError(CODES.PARAM_INVALID, '请至少授权一家门店');
  }
  const allStores = role === 'BRAND_ADMIN' ? 1 : 0;
  const now = Date.now();

  if (b.id) {
    const exist = await db.queryOne('SELECT * FROM mp_staff WHERE id = ? AND brand_id = ?', [b.id, ctx.scope.brandId]);
    if (!exist) throw notFound('员工不存在');
    if (exist.role === 'BRAND_ADMIN' && ctx.scope.role !== 'BRAND_ADMIN') throw forbidden('无权修改品牌超管账号');
    await db.tx(async (tx) => {
      await tx.execute(
        'UPDATE mp_staff SET name=?, role=?, region=?, all_stores=?, phone=?, updated_at=? WHERE id=? AND brand_id=?',
        [name, role, String(b.region || '').slice(0, 64), allStores, String(b.phone || '').slice(0, 32), now, b.id, ctx.scope.brandId]
      );
      await tx.execute('DELETE FROM mp_staff_store WHERE staff_id = ?', [b.id]);
      for (const sid of storeIds) {
        await tx.execute('INSERT IGNORE INTO mp_staff_store (staff_id, store_id) VALUES (?,?)', [b.id, sid]);
      }
    });
    await staffAuth.audit(ctx, 'STAFF_UPDATE', 'staff:' + b.id, { role, storeIds });
    return ctx.ok({ id: b.id, updated: true });
  }

  if (!account) throw bizError(CODES.PARAM_INVALID, '请填写登录账号');
  if (!/^[a-z0-9_.-]{3,32}$/.test(account)) throw bizError(CODES.PARAM_INVALID, '账号只能包含小写字母/数字/._-，长度 3-32');
  const dup = await db.queryOne('SELECT id FROM mp_staff WHERE brand_id = ? AND account = ?', [ctx.scope.brandId, account]);
  if (dup) throw bizError(CODES.PARAM_INVALID, '该账号已存在');

  const initPwd = String(b.password || '').trim() || 'Lbz@' + Math.floor(100000 + Math.random() * 899999);
  staffAuth.assertPasswordStrength(initPwd);
  const { hash, salt } = staffAuth.hashPassword(initPwd);

  const id = await db.tx(async (tx) => {
    const r = await tx.execute(
      `INSERT INTO mp_staff (brand_id, account, password_hash, password_salt, name, phone, role, region, all_stores,
        must_change_pwd, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?)`,
      [ctx.scope.brandId, account, hash, salt, name, String(b.phone || '').slice(0, 32), role, String(b.region || '').slice(0, 64), allStores, now, now]
    );
    for (const sid of storeIds) {
      await tx.execute('INSERT IGNORE INTO mp_staff_store (staff_id, store_id) VALUES (?,?)', [r.insertId, sid]);
    }
    return r.insertId;
  });
  await staffAuth.audit(ctx, 'STAFF_CREATE', 'staff:' + id, { account, role, storeIds });
  logger.info('staff created', { id, account, role, by: ctx.staff.id });
  /* 初始密码只在创建时返回一次（且首登强制改密） */
  return ctx.ok({ id, account, initialPassword: initPwd, mustChangePwd: true });
}

async function toggleStaff(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.STAFF_WRITE);
  const id = toInt(ctx.params.id, 0);
  const target = await db.queryOne('SELECT * FROM mp_staff WHERE id = ? AND brand_id = ?', [id, ctx.scope.brandId]);
  if (!target) throw notFound('员工不存在');
  if (target.role === 'BRAND_ADMIN' && ctx.scope.role !== 'BRAND_ADMIN') throw forbidden('无权停用品牌超管');
  if (Number(target.id) === Number(ctx.staff.id)) throw bizError(CODES.PARAM_INVALID, '不能停用自己的账号');
  const status = ctx.body && ctx.body.status ? 1 : 0;
  await db.execute('UPDATE mp_staff SET status = ?, updated_at = ? WHERE id = ?', [status, Date.now(), id]);
  await staffAuth.audit(ctx, status ? 'STAFF_ENABLE' : 'STAFF_DISABLE', 'staff:' + id, { account: target.account });
  return ctx.ok({ ok: true, status });
}

async function resetStaffPassword(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.STAFF_WRITE);
  const id = toInt(ctx.params.id, 0);
  const target = await db.queryOne('SELECT * FROM mp_staff WHERE id = ? AND brand_id = ?', [id, ctx.scope.brandId]);
  if (!target) throw notFound('员工不存在');
  if (target.role === 'BRAND_ADMIN' && ctx.scope.role !== 'BRAND_ADMIN') throw forbidden('无权重置品牌超管密码');
  const newPwd = String((ctx.body && ctx.body.password) || '').trim() || 'Lbz@' + Math.floor(100000 + Math.random() * 899999);
  staffAuth.assertPasswordStrength(newPwd);
  const { hash, salt } = staffAuth.hashPassword(newPwd);
  await db.execute('UPDATE mp_staff SET password_hash=?, password_salt=?, must_change_pwd=1, fail_count=0, locked_until=0, updated_at=? WHERE id=?', [
    hash, salt, Date.now(), id,
  ]);
  await staffAuth.audit(ctx, 'STAFF_RESET_PWD', 'staff:' + id, { account: target.account });
  return ctx.ok({ ok: true, newPassword: newPwd, mustChangePwd: true });
}

/* ============================================================ 菜单与库存 */
async function listDishes(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.DISH_READ);
  const storeId = ctx.query.storeId || '';
  if (storeId) rbac.assertStore(ctx, storeId);
  const rows = await db.query(
    `SELECT d.*, c.name AS category_name,
            COALESCE(sd.stock,0) AS store_stock, COALESCE(sd.sold,0) AS store_sold,
            COALESCE(sd.status,0) AS store_status, COALESCE(sd.price_override,0) AS price_override
     FROM mp_dish d
     LEFT JOIN mp_category c ON c.id = d.category_id
     LEFT JOIN mp_store_dish sd ON sd.dish_id = d.id AND sd.store_id = ?
     WHERE d.brand_id = ? ORDER BY c.sort, d.sort`,
    [storeId, ctx.scope.brandId]
  );
  const categories = await db.query('SELECT id, name FROM mp_category WHERE brand_id = ? ORDER BY sort', [ctx.scope.brandId]);
  return ctx.ok({
    list: rows.map((d) => ({
      id: d.id, name: d.name, categoryId: d.category_id, categoryName: d.category_name,
      emoji: d.emoji, price: Number(d.price), priceText: (Number(d.price) / 100).toFixed(2),
      unit: d.unit, spicy: !!d.spicy, status: Number(d.status),
      storeStock: Number(d.store_stock), storeSold: Number(d.store_sold),
      storeStatus: Number(d.store_status), priceOverride: Number(d.price_override),
      effectivePrice: Number(d.price_override) || Number(d.price),
    })),
    categories,
    storeId,
  });
}

async function saveDish(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.DISH_WRITE);
  const b = ctx.body || {};
  const name = String(b.name || '').trim().slice(0, 128);
  if (!name) throw bizError(CODES.PARAM_INVALID, '请填写菜品名称');
  const price = Math.max(1, toInt(b.price, 0));
  const categoryId = String(b.categoryId || '').slice(0, 32);
  const cat = await db.queryOne('SELECT id FROM mp_category WHERE id = ? AND brand_id = ?', [categoryId, ctx.scope.brandId]);
  if (!cat) throw bizError(CODES.PARAM_INVALID, '分类不存在');
  const now = Date.now();

  if (b.id) {
    const exist = await db.queryOne('SELECT id FROM mp_dish WHERE id = ? AND brand_id = ?', [b.id, ctx.scope.brandId]);
    if (!exist) throw notFound('菜品不存在');
    await db.execute(
      `UPDATE mp_dish SET category_id=?, name=?, description=?, emoji=?, price=?, unit=?, spicy=?, tags=?, sort=?, updated_at=?
       WHERE id=? AND brand_id=?`,
      [categoryId, name, String(b.description || '').slice(0, 250), String(b.emoji || '🍢').slice(0, 8), price,
       String(b.unit || '份').slice(0, 16), b.spicy ? 1 : 0, JSON.stringify(b.tags || []), toInt(b.sort, 0), now, b.id, ctx.scope.brandId]
    );
    await staffAuth.audit(ctx, 'DISH_UPDATE', 'dish:' + b.id, { name, price });
    return ctx.ok({ id: b.id, updated: true });
  }

  const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  await db.tx(async (tx) => {
    await tx.execute(
      `INSERT INTO mp_dish (id, brand_id, category_id, name, description, emoji, image, price, unit, spicy, tags, status, sort, updated_at)
       VALUES (?,?,?,?,?,?,'',?,?,?,?,1,?,?)`,
      [id, ctx.scope.brandId, categoryId, name, String(b.description || '').slice(0, 250), String(b.emoji || '🍢').slice(0, 8),
       price, String(b.unit || '份').slice(0, 16), b.spicy ? 1 : 0, JSON.stringify(b.tags || []), toInt(b.sort, 0), now]
    );
    const stores = await tx.query('SELECT id FROM mp_store WHERE brand_id = ? AND status = 1', [ctx.scope.brandId]);
    for (const s of stores) {
      await tx.execute('INSERT IGNORE INTO mp_store_dish (store_id, dish_id, price_override, stock, sold, status, updated_at) VALUES (?,?,0,0,0,1,?)', [
        s.id, id, now,
      ]);
    }
  });
  await staffAuth.audit(ctx, 'DISH_CREATE', 'dish:' + id, { name, price });
  return ctx.ok({ id, created: true });
}

async function toggleDish(ctx) {
  const b = ctx.body || {};
  rbac.assertPerm(ctx, b.storeId ? rbac.PERMS.DISH_STOCK : rbac.PERMS.DISH_WRITE);
  const dishId = ctx.params.id;
  const dish = await db.queryOne('SELECT id FROM mp_dish WHERE id = ? AND brand_id = ?', [dishId, ctx.scope.brandId]);
  if (!dish) throw notFound('菜品不存在');
  if (b.storeId) {
    rbac.assertStore(ctx, b.storeId);
    const r = await db.execute('UPDATE mp_store_dish SET status = ?, updated_at = ? WHERE store_id = ? AND dish_id = ?', [
      b.status ? 1 : 0, Date.now(), b.storeId, dishId,
    ]);
    if (r.affectedRows === 0) throw notFound('该门店未配置此菜品，请先同步菜单');
    await internalApi.invalidateMenuCache(b.storeId);
    await staffAuth.audit(ctx, 'STORE_DISH_STATUS', dishId, { storeId: b.storeId, status: b.status });
    return ctx.ok({ ok: true });
  }
  await db.execute('UPDATE mp_dish SET status = ?, updated_at = ? WHERE id = ? AND brand_id = ?', [
    b.status ? 1 : 0, Date.now(), dishId, ctx.scope.brandId,
  ]);
  await internalApi.invalidateMenuCache('');
  await staffAuth.audit(ctx, 'DISH_STATUS', dishId, { status: b.status });
  return ctx.ok({ ok: true });
}

/** 批量更新门店库存 / 门店改价（管理端最高频操作） */
async function updateStoreDish(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.DISH_STOCK);
  const b = ctx.body || {};
  const storeId = String(b.storeId || '');
  if (!storeId) throw bizError(CODES.PARAM_INVALID, '请指定门店');
  rbac.assertStore(ctx, storeId);
  const items = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
  if (!items.length) throw bizError(CODES.PARAM_INVALID, '没有需要更新的菜品');

  let updated = 0;
  await db.tx(async (tx) => {
    for (const it of items) {
      const dishId = String(it.dishId || '').slice(0, 32);
      if (!dishId) continue;
      const fields = [];
      const params = [];
      if (it.stock !== undefined) {
        fields.push('stock = ?');
        params.push(Math.max(0, toInt(it.stock, 0)));
      }
      if (it.status !== undefined) {
        fields.push('status = ?');
        params.push(it.status ? 1 : 0);
      }
      if (it.priceOverride !== undefined) {
        const po = Math.max(0, toInt(it.priceOverride, 0));
        /* 门店改价上限：不超过品牌指导价 2 倍，防止加盟店乱定价伤害品牌 */
        const d = await tx.queryOne('SELECT price FROM mp_dish WHERE id = ?', [dishId]);
        if (d && po > Number(d.price) * 2) throw bizError(CODES.PARAM_INVALID, `门店价不能超过指导价的 2 倍（${dishId}）`);
        fields.push('price_override = ?');
        params.push(po);
      }
      if (!fields.length) continue;
      fields.push('updated_at = ?');
      params.push(Date.now());
      params.push(storeId, dishId);
      const r = await tx.execute(`UPDATE mp_store_dish SET ${fields.join(', ')} WHERE store_id = ? AND dish_id = ?`, params);
      updated += r.affectedRows;
    }
  });
  await internalApi.invalidateMenuCache(storeId);
  await staffAuth.audit(ctx, 'STORE_DISH_UPDATE', storeId, { count: updated });
  return ctx.ok({ ok: true, updated });
}

/* ============================================================ 订单 */
const FLOW = {
  accept: { from: [ORDER_STATUS.PAID], to: ORDER_STATUS.ACCEPTED, text: '商家接单', perm: rbac.PERMS.ORDER_ADVANCE },
  cook: { from: [ORDER_STATUS.ACCEPTED], to: ORDER_STATUS.COOKING, text: '开始制作', perm: rbac.PERMS.ORDER_ADVANCE },
  ready: { from: [ORDER_STATUS.COOKING], to: ORDER_STATUS.READY, text: '已出餐', perm: rbac.PERMS.ORDER_ADVANCE },
  done: { from: [ORDER_STATUS.READY], to: ORDER_STATUS.DONE, text: '订单完成', perm: rbac.PERMS.ORDER_ADVANCE },
};

async function listOrders(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.ORDER_READ);
  const { page, size } = pageArgs(ctx.query, 30, 100);
  const { start, end } = dayRange(ctx.query.date);
  const storeId = ctx.query.storeId || '';
  if (storeId) rbac.assertStore(ctx, storeId);

  /**
   * 订单 DTO 由小程序后端产出（展示口径只有一份），本服务只负责：
   *   ① 权限点校验  ② 门店范围计算  ③ 把范围传给对方
   */
  const storeIds = storeId ? [storeId] : ctx.scope.storeIds || [];
  const qs = new URLSearchParams();
  if (ctx.scope.allStores) qs.set('allStores', '1');
  else qs.set('storeIds', storeIds.join(','));
  qs.set('brandId', ctx.scope.brandId);
  if (ctx.query.status) qs.set('status', String(ctx.query.status));
  if (ctx.query.keyword) qs.set('keyword', String(ctx.query.keyword));
  qs.set('from', String(start));
  qs.set('to', String(end));
  qs.set('page', String(page));
  qs.set('size', String(size));
  const r = await internalApi.listOrders(qs.toString());
  return ctx.ok(r);
}

async function advance(ctx, action) {
  rbac.assertPerm(ctx, rbac.PERMS.ORDER_ADVANCE);
  if (FLOW_ACTIONS.indexOf(action) === -1) throw bizError(CODES.PARAM_INVALID, '未知的流转动作：' + action);
  const orderId = ctx.params.id;
  const order = await db.queryOne('SELECT id, store_id, status FROM mp_order WHERE id = ? AND brand_id = ?', [orderId, ctx.scope.brandId]);
  if (!order) throw notFound('订单不存在');
  /* 门店范围必须先在本地断言——不能把「能不能操作」的判断甩给下游服务 */
  rbac.assertStore(ctx, order.store_id);
  const r = await internalApi.advanceOrder(orderId, action, ctx.staff.id);
  await staffAuth.audit(ctx, 'ORDER_' + action.toUpperCase(), orderId, { from: order.status, to: r && r.status });
  return ctx.ok(r);
}

async function rejectOrder(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.ORDER_CANCEL);
  const orderId = ctx.params.id;
  const reason = String((ctx.body && ctx.body.reason) || '商家拒单').slice(0, 100);
  const order = await db.queryOne('SELECT id, store_id, status FROM mp_order WHERE id = ? AND brand_id = ?', [orderId, ctx.scope.brandId]);
  if (!order) throw notFound('订单不存在');
  rbac.assertStore(ctx, order.store_id);
  const r = await internalApi.rejectOrder(orderId, reason, ctx.staff.id);
  await staffAuth.audit(ctx, r && r.refunded ? 'ORDER_REJECT_REFUND' : 'ORDER_REJECT', orderId, { reason });
  return ctx.ok(r);
}

async function listRefunds(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.ORDER_READ);
  const params = [ctx.scope.brandId];
  const where = "WHERE o.brand_id = ? AND r.status IN ('APPLIED','APPROVED')";
  const scoped = rbac.applyScope(where, params, ctx, 'o.store_id');
  if (scoped.empty) return ctx.ok([]);
  const rows = await db.query(
    `SELECT r.*, o.order_no, o.status AS orderStatus, o.store_id, s.name AS store_name
     FROM mp_refund r LEFT JOIN mp_order o ON o.id = r.order_id LEFT JOIN mp_store s ON s.id = o.store_id
     ${scoped.where} ORDER BY r.created_at ASC LIMIT 100`,
    scoped.params
  );
  return ctx.ok(rows);
}

async function approveRefund(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.ORDER_CANCEL);
  const row = await db.queryOne('SELECT r.*, o.store_id FROM mp_refund r LEFT JOIN mp_order o ON o.id = r.order_id WHERE r.id = ?', [ctx.params.id]);
  if (!row) throw notFound('退款申请不存在');
  rbac.assertStore(ctx, row.store_id);
  const r = await internalApi.approveRefund(ctx.params.id, ctx.staff.id);
  await staffAuth.audit(ctx, 'REFUND_APPROVE', String(row.order_id), { amount: row.amount, reason: row.reason });
  return ctx.ok(r);
}

async function rejectRefund(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.ORDER_CANCEL);
  const row = await db.queryOne('SELECT r.*, o.store_id FROM mp_refund r LEFT JOIN mp_order o ON o.id = r.order_id WHERE r.id = ?', [ctx.params.id]);
  if (!row) throw notFound('退款申请不存在');
  rbac.assertStore(ctx, row.store_id);
  const r = await internalApi.rejectRefund(ctx.params.id, ctx.staff.id);
  await staffAuth.audit(ctx, 'REFUND_REJECT', String(row.order_id), {});
  return ctx.ok(r);
}

/* ============================================================ 经营统计 */
async function stats(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.STATS_READ);
  const { start, end } = dayRange(ctx.query.date);
  const storeId = ctx.query.storeId || '';
  if (storeId) rbac.assertStore(ctx, storeId);

  const params = [ctx.scope.brandId, start, end];
  let where = 'brand_id = ? AND created_at >= ? AND created_at < ?';
  if (storeId) {
    where += ' AND store_id = ?';
    params.push(storeId);
  } else if (!ctx.scope.allStores) {
    const ids = ctx.scope.storeIds || [];
    if (!ids.length) {
      return ctx.ok({ date: new Date(start).toISOString().slice(0, 10), orderCount: 0, paidCount: 0, revenue: 0, revenueText: '0.00', byStore: [], byType: [] });
    }
    where += ` AND store_id IN (${ids.map(() => '?').join(',')})`;
    params.push.apply(params, ids);
  }

  const row = await db.queryOne(
    `SELECT COUNT(*) AS orderCount,
       SUM(CASE WHEN status IN ('PAID','ACCEPTED','COOKING','READY','DONE') THEN 1 ELSE 0 END) AS paidCount,
       SUM(CASE WHEN status IN ('PAID','ACCEPTED','COOKING','READY','DONE') THEN pay_amount ELSE 0 END) AS revenue,
       SUM(CASE WHEN status = 'UNPAID' THEN 1 ELSE 0 END) AS unpaidCount,
       SUM(CASE WHEN status = 'CANCELED' THEN 1 ELSE 0 END) AS canceledCount
     FROM mp_order WHERE ${where}`,
    params
  );

  /* 门店维度对比（直营 vs 加盟是品牌最关心的两块） */
  const oWhere = where
    .replace(/^brand_id/, 'o.brand_id')
    .replace(/ created_at >=/, ' o.created_at >=')
    .replace(/ created_at </, ' o.created_at <')
    .replace(/ AND store_id = \?/, ' AND o.store_id = ?')
    .replace(/ AND store_id IN/, ' AND o.store_id IN');
  const byStore = await db.query(
    `SELECT o.store_id, s.name AS store_name, s.type,
            COUNT(*) AS orderCount,
            SUM(CASE WHEN o.status IN ('PAID','ACCEPTED','COOKING','READY','DONE') THEN o.pay_amount ELSE 0 END) AS revenue
     FROM mp_order o LEFT JOIN mp_store s ON s.id = o.store_id
     WHERE ${oWhere}
     GROUP BY o.store_id, s.name, s.type ORDER BY revenue DESC`,
    params
  );

  const byType = { DIRECT: { orders: 0, revenue: 0 }, FRANCHISE: { orders: 0, revenue: 0 } };
  byStore.forEach((s) => {
    const t = s.type === 'FRANCHISE' ? 'FRANCHISE' : 'DIRECT';
    byType[t].orders += Number(s.orderCount || 0);
    byType[t].revenue += Number(s.revenue || 0);
  });

  const paid = Number(row.paidCount || 0);
  const revenue = Number(row.revenue || 0);
  return ctx.ok({
    date: new Date(start).toISOString().slice(0, 10),
    orderCount: Number(row.orderCount || 0),
    paidCount: paid,
    unpaidCount: Number(row.unpaidCount || 0),
    canceledCount: Number(row.canceledCount || 0),
    revenue,
    revenueText: (revenue / 100).toFixed(2),
    avgAmount: paid ? (revenue / paid / 100).toFixed(2) : '0.00',
    byStore: byStore.map((s) => ({
      storeId: s.store_id, storeName: s.store_name, type: s.type,
      typeText: s.type === 'FRANCHISE' ? '加盟' : '直营',
      orderCount: Number(s.orderCount || 0),
      revenue: Number(s.revenue || 0),
      revenueText: (Number(s.revenue || 0) / 100).toFixed(2),
    })),
    byType: [
      { type: 'DIRECT', typeText: '直营', orderCount: byType.DIRECT.orders, revenue: byType.DIRECT.revenue, revenueText: (byType.DIRECT.revenue / 100).toFixed(2) },
      { type: 'FRANCHISE', typeText: '加盟', orderCount: byType.FRANCHISE.orders, revenue: byType.FRANCHISE.revenue, revenueText: (byType.FRANCHISE.revenue / 100).toFixed(2) },
    ],
  });
}

/* ============================================================ 优惠券 */
async function listCoupons(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.COUPON_READ);
  return ctx.ok(await couponService.listTemplates(ctx.scope, ctx.query));
}
async function saveCoupon(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.COUPON_WRITE);
  const body = ctx.body || {};
  /* 门店范围必须落在自己的授权内，否则等于给别家店发券 */
  if (Array.isArray(body.storeIds) && body.storeIds.length && !ctx.scope.allStores) {
    const mine = new Set(ctx.scope.storeIds || []);
    const bad = body.storeIds.map(String).filter((i) => !mine.has(i));
    if (bad.length) throw forbidden('不能把券限定给自己无权管理的门店：' + bad.join(','));
  }
  const r = await couponService.saveTemplate(ctx.scope, ctx.staff.id, body);
  await staffAuth.audit(ctx, body.id ? 'COUPON_UPDATE' : 'COUPON_CREATE', r.id, { name: body.name });
  return ctx.ok(r);
}
async function toggleCoupon(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.COUPON_WRITE);
  const r = await couponService.toggleTemplate(ctx.scope, ctx.params.id, ctx.body && ctx.body.status);
  await staffAuth.audit(ctx, 'COUPON_STATUS', ctx.params.id, { status: !!(ctx.body && ctx.body.status) });
  return ctx.ok(r);
}
async function grantCoupon(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.COUPON_ISSUE);
  const b = ctx.body || {};
  /* 兼容两种调用：/admin/coupons/:id/grant（REST 风格）与 body 里带 couponId */
  const couponId = String(ctx.params.id || b.couponId || '');
  if (!couponId) throw bizError(CODES.PARAM_INVALID, '请选择优惠券');
  /* 防超发与限领规则在小程序后端（couponService.receive），这里不做本地实现 */
  const targets = { userIds: b.userIds, phones: b.phones, openids: b.openids };
  const hasTarget =
    (Array.isArray(b.userIds) && b.userIds.length) ||
    (Array.isArray(b.phones) && b.phones.length) ||
    (Array.isArray(b.openids) && b.openids.length);
  if (!hasTarget) throw bizError(CODES.PARAM_INVALID, '未匹配到任何用户（支持用户 id / 手机号 / openid）');
  const r = await internalApi.grantCoupon(couponId, targets, ctx.staff.id);
  await staffAuth.audit(ctx, 'COUPON_GRANT', couponId, { total: r.total, ok: r.success });
  return ctx.ok(r);
}
async function couponStats(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.COUPON_READ);
  return ctx.ok(await couponService.stats(ctx.scope, ctx.query));
}

/* ============================================================ 主题 */
async function listThemes(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.THEME_READ);
  return ctx.ok({
    list: await themeService.listThemes(ctx.scope, ctx.query),
    presets: Object.keys(themeService.PRESETS).map((k) => Object.assign({ key: k }, themeService.PRESETS[k])),
    defaultTokens: themeService.DEFAULT_TOKENS,
    current: await themeService.resolveTheme(ctx.scope.brandId, ctx.query.storeId || ''),
  });
}
async function saveTheme(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.THEME_WRITE);
  const r = await themeService.saveTheme(ctx.scope, ctx.staff.id, ctx.body || {});
  await staffAuth.audit(ctx, ctx.body && ctx.body.id ? 'THEME_UPDATE' : 'THEME_CREATE', r.id, { name: ctx.body && ctx.body.name });
  return ctx.ok(r);
}
async function activateTheme(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.THEME_WRITE);
  const r = await themeService.activateTheme(ctx.scope, ctx.staff.id, ctx.params.id);
  await staffAuth.audit(ctx, 'THEME_ACTIVATE', ctx.params.id, {});
  return ctx.ok(r);
}
async function toggleTheme(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.THEME_WRITE);
  const r = await themeService.toggleTheme(ctx.scope, ctx.params.id, ctx.body && ctx.body.status);
  await staffAuth.audit(ctx, 'THEME_STATUS', ctx.params.id, { status: !!(ctx.body && ctx.body.status) });
  return ctx.ok(r);
}
async function deleteTheme(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.THEME_WRITE);
  const r = await themeService.deleteTheme(ctx.scope, ctx.params.id);
  await staffAuth.audit(ctx, 'THEME_DELETE', ctx.params.id, {});
  return ctx.ok(r);
}

/* ============================================================ 团购券核销 */
async function verifyVoucher(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.VOUCHER_VERIFY);
  const b = ctx.body || {};
  const storeId = String(b.storeId || '').slice(0, 32);
  if (!storeId) throw bizError(CODES.PARAM_INVALID, '请选择核销门店');
  rbac.assertStore(ctx, storeId);
  /**
   * 核销必须走小程序后端：防重复核销靠 mp_voucher 的唯一键 + 平台校验，
   * 这套规则只有一份，管理端不能自己 INSERT。
   */
  const result = await internalApi.verifyVoucher({
    code: b.code,
    storeId,
    platform: String(b.platform || 'MEITUAN').slice(0, 16),
    staffId: ctx.staff.id,
  });
  await staffAuth.audit(ctx, 'VOUCHER_VERIFY', result.code, { storeId, product: result.productName, faceValue: result.faceValue });
  return ctx.ok(result);
}
async function refundVoucher(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.VOUCHER_REFUND);
  const row = await db.queryOne('SELECT * FROM mp_voucher WHERE id = ?', [toInt(ctx.params.id, 0)]);
  if (!row) throw notFound('核销记录不存在');
  rbac.assertStore(ctx, row.store_id);
  const r = await internalApi.refundVoucher(row.id, ctx.staff.id);
  await staffAuth.audit(ctx, 'VOUCHER_REFUND', row.code, { voucherId: row.id });
  return ctx.ok(r);
}
async function listVouchers(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.VOUCHER_READ);
  if (ctx.query.storeId) rbac.assertStore(ctx, ctx.query.storeId);
  /**
   * 门店范围在本函数内过滤（不是查出来再判断）：
   * 无授权门店时返回空列表，最坏情况是「查不到」而不是「泄露」。
   */
  return ctx.ok(await voucherQuery.listVouchers(ctx.scope, ctx.query));
}

/* ============================================================ 审计 */
async function listAudit(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.AUDIT_READ);
  const { page, size } = pageArgs(ctx.query, 50, 200);
  const params = [ctx.scope.brandId];
  let where = 'WHERE a.brand_id = ?';
  if (ctx.query.action) {
    where += ' AND a.action LIKE ?';
    params.push('%' + String(ctx.query.action).slice(0, 32) + '%');
  }
  if (ctx.query.staffId) {
    where += ' AND a.staff_id = ?';
    params.push(toInt(ctx.query.staffId, 0));
  }
  const from = toInt(ctx.query.from, 0);
  const to = toInt(ctx.query.to, 0);
  if (from) {
    where += ' AND a.created_at >= ?';
    params.push(from);
  }
  if (to) {
    where += ' AND a.created_at <= ?';
    params.push(to);
  }
  const total = await db.queryOne(`SELECT COUNT(*) AS c FROM mp_audit_log a ${where}`, params);
  const rows = await db.query(
    `SELECT a.*, s.name AS store_name FROM mp_audit_log a LEFT JOIN mp_store s ON s.id = a.store_id
     ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    params.concat([size, (page - 1) * size])
  );
  return ctx.ok({
    total: Number(total.c),
    page,
    size,
    list: rows.map((r) => ({
      id: r.id, staffName: r.staff_name, role: r.role, action: r.action,
      target: r.target, detail: r.detail, storeId: r.store_id, storeName: r.store_name,
      ip: r.ip, requestId: r.request_id,
      createdAt: Number(r.created_at),
      createdAtText: new Date(Number(r.created_at)).toLocaleString('zh-CN'),
    })),
  });
}

async function listLoginLogs(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.AUDIT_READ);
  const { page, size } = pageArgs(ctx.query, 50, 200);
  const total = await db.queryOne('SELECT COUNT(*) AS c FROM mp_login_log WHERE brand_id = ?', [ctx.scope.brandId]);
  const rows = await db.query('SELECT * FROM mp_login_log WHERE brand_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [
    ctx.scope.brandId, size, (page - 1) * size,
  ]);
  return ctx.ok({
    total: Number(total.c),
    page,
    size,
    list: rows.map((r) => ({
      id: r.id, account: r.account, success: !!r.success, reason: r.reason, ip: r.ip, ua: r.ua,
      createdAt: Number(r.created_at),
      createdAtText: new Date(Number(r.created_at)).toLocaleString('zh-CN'),
    })),
  });
}

/* ============================================================ 看板首页 */
async function summary(ctx) {
  rbac.assertPerm(ctx, rbac.PERMS.STATS_READ);
  const today = dayRange();
  const brand = await db.queryOne('SELECT id, name, logo FROM mp_brand WHERE id = ?', [ctx.scope.brandId]);
  const stores = await db.query('SELECT id, name, type FROM mp_store WHERE brand_id = ? AND status = 1', [ctx.scope.brandId]);
  const allowed = stores.filter((s) => rbac.inScope(ctx.scope, s.id));

  let orderRow = { c: 0, revenue: 0 };
  let voucherRow = { c: 0, amount: 0 };
  let pendingRow = { c: 0 };
  if (allowed.length) {
    const ids = allowed.map((s) => s.id);
    const ph = ids.map(() => '?').join(',');
    orderRow = await db.queryOne(
      `SELECT COUNT(*) AS c, SUM(CASE WHEN status IN ('PAID','ACCEPTED','COOKING','READY','DONE') THEN pay_amount ELSE 0 END) AS revenue
       FROM mp_order WHERE store_id IN (${ph}) AND created_at >= ? AND created_at < ?`,
      ids.concat([today.start, today.end])
    );
    voucherRow = await db.queryOne(
      `SELECT COUNT(*) AS c, SUM(face_value) AS amount FROM mp_voucher
       WHERE store_id IN (${ph}) AND status = 'VERIFIED' AND created_at >= ? AND created_at < ?`,
      ids.concat([today.start, today.end])
    );
    pendingRow = await db.queryOne(`SELECT COUNT(*) AS c FROM mp_order WHERE store_id IN (${ph}) AND status = 'PAID'`, ids);
  }

  return ctx.ok({
    brand,
    scope: {
      role: ctx.scope.role,
      roleName: (rbac.roleMeta(ctx.scope.role) || {}).name,
      allStores: ctx.scope.allStores,
      storeCount: allowed.length,
      storeNames: allowed.map((s) => s.name),
      region: ctx.scope.region,
    },
    today: {
      orderCount: Number(orderRow.c || 0),
      revenue: Number(orderRow.revenue || 0),
      revenueText: (Number(orderRow.revenue || 0) / 100).toFixed(2),
      pendingAcceptCount: Number(pendingRow.c || 0),
      voucherCount: Number(voucherRow.c || 0),
      voucherAmountText: (Number(voucherRow.amount || 0) / 100).toFixed(2),
    },
    staff: {
      name: ctx.staff.name,
      account: ctx.staff.account,
      perms: (rbac.roleMeta(ctx.scope.role) || {}).perms || [],
    },
  });
}

module.exports = {
  getBrand, saveBrand,
  listStores, saveStore, toggleStore, syncStoreMenu,
  listStaff, saveStaff, toggleStaff, resetStaffPassword,
  listDishes, saveDish, toggleDish, updateStoreDish,
  listOrders, advance, rejectOrder, listRefunds, approveRefund, rejectRefund, stats,
  listCoupons, saveCoupon, toggleCoupon, grantCoupon, couponStats,
  listThemes, saveTheme, activateTheme, toggleTheme, deleteTheme,
  verifyVoucher, listVouchers, refundVoucher,
  listAudit, listLoginLogs, summary,
};
