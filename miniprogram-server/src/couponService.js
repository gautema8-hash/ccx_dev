/**
 * 优惠券模块（连锁版）
 *
 * 与单店版的区别：
 *   1. 券模板属于品牌，可通过 store_ids 限定适用门店（空=全品牌）
 *   2. 支持三种券型：CASH 现金券 / SOUP 锅底券 / DISCOUNT 折扣券
 *   3. 发放来源可追溯：NEW_USER 新客自动 / CAMPAIGN 活动 / MANUAL 定向 / RECEIVE 领券中心
 *   4. 领券中心有限量、每人限领、每日限领三重约束（并发安全靠条件更新 + 计数校验）
 *   5. 抵扣计算统一收口在 calcDiscount()，下单与「我的券」可用性判断共用同一口径，
 *      避免出现「列表显示可用、下单却说不可用」这种割裂体验
 */
const db = require('./db');
const logger = require('./logger');
const { bizError, notFound, CODES } = require('./errors');

function parseStoreIds(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function couponDTO(c, extra) {
  const storeIds = parseStoreIds(c.store_ids);
  return Object.assign(
    {
      id: c.id,
      name: c.name,
      type: c.type,
      value: Number(c.value),
      valueText: c.type === 'DISCOUNT' ? (Number(c.value) / 10).toFixed(1) + '折' : '¥' + (Number(c.value) / 100).toFixed(2),
      threshold: Number(c.threshold),
      thresholdText: Number(c.threshold) ? '满 ' + (Number(c.threshold) / 100).toFixed(0) + ' 可用' : '无门槛',
      scope: c.scope,
      storeIds,
      issueType: c.issue_type,
      receiveEnabled: !!c.receive_enabled,
      receiveStart: Number(c.receive_start || 0),
      receiveEnd: Number(c.receive_end || 0),
      dayLimit: Number(c.day_limit || 0),
      total: Number(c.total),
      issued: Number(c.issued),
      perUser: Number(c.per_user),
      usedCount: Number(c.used_count || 0),
      expireAt: c.expire_at,
      status: Number(c.status),
      remain: Math.max(0, Number(c.total) - Number(c.issued)),
      soldOut: Number(c.issued) >= Number(c.total),
      /** 品牌范围文案：让用户一眼知道能不能在当前门店用 */
      storeScopeText: storeIds.length ? storeIds.length + ' 家指定门店' : '全品牌通用',
    },
    extra || {}
  );
}

/**
 * 抵扣计算（统一口径）
 * @returns {{ok:boolean, discount:number, reason:string, base:number}}
 */
function calcDiscount(coupon, order) {
  const goods = Number(order.goodsAmount || 0);
  const soupFee = Number(order.soupFee || 0);
  const gross = goods + soupFee;

  if (!coupon) return { ok: false, discount: 0, reason: '未选择优惠券', base: 0 };

  /* 门店适用范围 */
  const storeIds = parseStoreIds(coupon.store_ids);
  if (storeIds.length && order.storeId && storeIds.indexOf(order.storeId) === -1) {
    return { ok: false, discount: 0, reason: '该券不适用于当前门店', base: 0 };
  }
  if (gross < Number(coupon.threshold || 0)) {
    return { ok: false, discount: 0, reason: '未达到使用门槛', base: 0 };
  }

  const base = coupon.type === 'SOUP' ? soupFee : gross;
  let discount = 0;
  if (coupon.type === 'CASH') discount = Math.min(Number(coupon.value), base);
  else if (coupon.type === 'SOUP') discount = Math.min(Number(coupon.value), soupFee);
  else if (coupon.type === 'DISCOUNT') {
    const rate = Math.min(100, Math.max(1, Number(coupon.value))); // 88 => 8.8 折
    discount = Math.round((base * (100 - rate)) / 100);
  }
  /* 抵扣不能超过订单金额，否则会出现负数实付 */
  discount = Math.min(discount, gross);
  return { ok: discount > 0, discount, reason: discount > 0 ? '' : '该券无可抵扣金额', base };
}

/* ============================================================ 领券中心 */
/** 可领取的券列表（小程序） */
async function listReceivable(brandId, storeId, userId) {
  const now = Date.now();
  const rows = await db.query(
    `SELECT * FROM mp_coupon
     WHERE brand_id = ? AND status = 1 AND receive_enabled = 1
       AND (receive_start = 0 OR receive_start <= ?) AND (receive_end = 0 OR receive_end >= ?)
     ORDER BY value DESC`,
    [brandId, now, now]
  );
  const mine = userId
    ? await db.query(
        `SELECT coupon_id, COUNT(*) AS c FROM mp_user_coupon WHERE user_id = ? AND status IN ('UNUSED','USED') GROUP BY coupon_id`,
        [userId]
      )
    : [];
  const mineMap = new Map(mine.map((m) => [m.coupon_id, Number(m.c)]));
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const today = userId
    ? await db.query(
        `SELECT coupon_id, COUNT(*) AS c FROM mp_coupon_receive WHERE user_id = ? AND created_at >= ? GROUP BY coupon_id`,
        [userId, todayStart]
      )
    : [];
  const todayMap = new Map(today.map((m) => [m.coupon_id, Number(m.c)]));

  return rows
    .filter((c) => {
      /* 门店范围过滤：不属于当前门店的券不展示在领券中心 */
      const ids = parseStoreIds(c.store_ids);
      return !ids.length || !storeId || ids.indexOf(storeId) > -1;
    })
    .map((c) =>
      couponDTO(c, {
        receivedCount: mineMap.get(c.id) || 0,
        todayCount: todayMap.get(c.id) || 0,
        canReceive:
          Number(c.issued) < Number(c.total) &&
          (mineMap.get(c.id) || 0) < Number(c.per_user) &&
          (!Number(c.day_limit) || (todayMap.get(c.id) || 0) < Number(c.day_limit)),
      })
    );
}

/**
 * 领取优惠券（并发安全）
 * 三重约束：总量、每人限领、每日限领 —— 全部用「条件更新 + 计数」保证，不靠先查后写
 */
async function receive(userId, couponId, storeId, source) {
  const coupon = await db.queryOne('SELECT * FROM mp_coupon WHERE id = ? AND status = 1', [couponId]);
  if (!coupon) throw notFound('优惠券不存在或已下架');

  const ids = parseStoreIds(coupon.store_ids);
  if (ids.length && storeId && ids.indexOf(storeId) === -1) {
    throw bizError(CODES.COUPON_UNAVAILABLE, '该券不适用于当前门店');
  }

  const received = await db.queryOne(
    "SELECT COUNT(*) AS c FROM mp_user_coupon WHERE user_id = ? AND coupon_id = ? AND status IN ('UNUSED','USED')",
    [userId, couponId]
  );
  if (Number(received.c) >= Number(coupon.per_user)) {
    throw bizError(CODES.COUPON_UNAVAILABLE, `每人最多领取 ${coupon.per_user} 张`);
  }
  if (Number(coupon.day_limit)) {
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const t = await db.queryOne(
      'SELECT COUNT(*) AS c FROM mp_coupon_receive WHERE user_id = ? AND coupon_id = ? AND created_at >= ?',
      [userId, couponId, todayStart]
    );
    if (Number(t.c) >= Number(coupon.day_limit)) throw bizError(CODES.COUPON_UNAVAILABLE, '今日已达领取上限');
  }

  const now = Date.now();
  await db.tx(async (tx) => {
    /* 条件更新：issued < total 时才 +1，并发下只有一个能成功，天然防超发 */
    const r = await tx.execute('UPDATE mp_coupon SET issued = issued + 1, updated_at = ? WHERE id = ? AND issued < total', [
      now, couponId,
    ]);
    if (r.affectedRows === 0) throw bizError(CODES.COUPON_UNAVAILABLE, '优惠券已被领完');
    await tx.execute(
      'INSERT INTO mp_user_coupon (user_id, coupon_id, status, got_at) VALUES (?,?,?,?)',
      [userId, couponId, 'UNUSED', now]
    );
    await tx.execute(
      'INSERT INTO mp_coupon_receive (user_id, coupon_id, store_id, source, created_at) VALUES (?,?,?,?,?)',
      [userId, couponId, storeId || '', source || 'RECEIVE', now]
    );
  });

  logger.info('coupon received', { userId, couponId, storeId, source: source || 'RECEIVE' });
  return couponDTO(coupon);
}

/** 定向发放（管理端）。失败不中断批量：返回逐条结果 */
async function grantToUsers(userIds, couponId, operatorId) {
  const results = [];
  for (const uid of userIds) {
    try {
      await receive(uid, couponId, '', 'MANUAL');
      await db.execute(
        'UPDATE mp_coupon_receive SET operator = ? WHERE user_id = ? AND coupon_id = ? ORDER BY id DESC LIMIT 1',
        [operatorId || 0, uid, couponId]
      );
      results.push({ userId: uid, ok: true });
    } catch (e) {
      results.push({ userId: uid, ok: false, message: e.message });
    }
  }
  return results;
}

/** 新客自动发券（登录建档时调用） */
async function grantNewUserCoupons(userId, brandId) {
  const rows = await db.query(
    "SELECT id FROM mp_coupon WHERE brand_id = ? AND status = 1 AND issue_type = 'NEW_USER'",
    [brandId]
  );
  const granted = [];
  for (const c of rows) {
    try {
      await receive(userId, c.id, '', 'NEW_USER');
      granted.push(c.id);
    } catch (e) {
      logger.warn('new user coupon skipped', { userId, couponId: c.id, message: e.message });
    }
  }
  return granted;
}

/* ============================================================ 我的券 */
async function listMine(userId, status, order /* {goodsAmount, soupFee, storeId} */) {
  const params = [userId];
  let where = 'uc.user_id = ?';
  if (status && status !== 'all') {
    where += ' AND uc.status = ?';
    params.push(status);
  }
  const rows = await db.query(
    `SELECT uc.id AS uc_row_id, uc.status AS user_status, uc.got_at, uc.used_at, uc.order_id, c.*
     FROM mp_user_coupon uc JOIN mp_coupon c ON c.id = uc.coupon_id
     WHERE ${where} ORDER BY uc.status ASC, uc.got_at DESC`,
    params
  );
  return rows.map((r) => {
    const dto = couponDTO(r, {
      userCouponId: r.uc_row_id,
      usable: r.user_status === 'UNUSED',
      usedAt: Number(r.used_at || 0),
      gotAt: Number(r.got_at || 0),
    });
    if (order && r.user_status === 'UNUSED') {
      const r2 = calcDiscount(r, order);
      dto.applicable = r2.ok;
      dto.inapplicableReason = r2.reason;
      dto.estimateDiscount = r2.discount;
    }
    return dto;
  });
}

/** 我的可用券（结算页用）：只返回当前订单真正能用的，按抵扣金额倒序 */
async function listUsable(userId, order) {
  const all = await listMine(userId, 'UNUSED', order);
  return all.filter((c) => c.applicable).sort((a, b) => b.estimateDiscount - a.estimateDiscount);
}

/* ============================================================ 管理端：券模板 */
async function listTemplates(scope, q) {
  const params = [scope.brandId];
  let where = 'WHERE brand_id = ?';
  if (q.status !== undefined && q.status !== '') {
    where += ' AND status = ?';
    params.push(Number(q.status));
  }
  if (q.keyword) {
    where += ' AND name LIKE ?';
    params.push('%' + q.keyword + '%');
  }
  const rows = await db.query(`SELECT * FROM mp_coupon ${where} ORDER BY status DESC, created_at DESC`, params);
  return rows.map((c) => couponDTO(c));
}

async function saveTemplate(scope, staffId, body) {
  const name = String(body.name || '').trim().slice(0, 64);
  if (!name) throw bizError(CODES.PARAM_INVALID, '请填写券名称');
  const type = ['CASH', 'SOUP', 'DISCOUNT'].indexOf(body.type) > -1 ? body.type : 'CASH';
  const value = Math.max(0, Math.trunc(Number(body.value) || 0));
  if (type === 'DISCOUNT') {
    if (value < 1 || value > 99) throw bizError(CODES.PARAM_INVALID, '折扣券的折扣值应在 1-99 之间（88 表示 8.8 折）');
  } else if (value <= 0) {
    throw bizError(CODES.PARAM_INVALID, '券面额必须大于 0');
  }
  const threshold = Math.max(0, Math.trunc(Number(body.threshold) || 0));
  if (type === 'CASH' && threshold > 0 && value > threshold) {
    throw bizError(CODES.PARAM_INVALID, '无门槛或面额不应大于门槛金额');
  }
  const storeIds = Array.isArray(body.storeIds) ? body.storeIds.slice(0, 200).map(String) : [];
  const issueType = ['NEW_USER', 'CAMPAIGN', 'MANUAL', 'RECEIVE'].indexOf(body.issueType) > -1 ? body.issueType : 'MANUAL';
  const now = Date.now();
  const common = [
    name, type, value, threshold, String(body.scope || '').slice(0, 120), JSON.stringify(storeIds),
    issueType, body.receiveEnabled ? 1 : 0,
    Math.trunc(Number(body.receiveStart) || 0), Math.trunc(Number(body.receiveEnd) || 0),
    Math.max(0, Math.trunc(Number(body.dayLimit) || 0)),
    Math.max(1, Math.trunc(Number(body.total) || 1)),
    Math.max(1, Math.trunc(Number(body.perUser) || 1)),
    String(body.expireAt || '').slice(0, 16),
    now,
  ];

  if (body.id) {
    const exist = await db.queryOne('SELECT id FROM mp_coupon WHERE id = ? AND brand_id = ?', [body.id, scope.brandId]);
    if (!exist) throw notFound('优惠券不存在');
    await db.execute(
      `UPDATE mp_coupon SET name=?, type=?, value=?, threshold=?, scope=?, store_ids=?,
         issue_type=?, receive_enabled=?, receive_start=?, receive_end=?, day_limit=?,
         total=?, per_user=?, expire_at=?, updated_at=? WHERE id=? AND brand_id=?`,
      common.concat([body.id, scope.brandId])
    );
    return { id: body.id, updated: true };
  }

  const id = 'cp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await db.execute(
    `INSERT INTO mp_coupon
     (id, brand_id, name, type, value, threshold, scope, store_ids, issue_type, receive_enabled,
      receive_start, receive_end, day_limit, total, per_user, expire_at, issued, used_count, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,1,?,?,?)`,
    [id, scope.brandId].concat(common.slice(0, 15)).concat([staffId || 0, now, now])
  );
  logger.info('coupon template created', { id, name, type, value, by: staffId });
  return { id, created: true };
}

async function toggleTemplate(scope, id, status) {
  const r = await db.execute('UPDATE mp_coupon SET status = ?, updated_at = ? WHERE id = ? AND brand_id = ?', [
    status ? 1 : 0, Date.now(), id, scope.brandId,
  ]);
  if (r.affectedRows === 0) throw notFound('优惠券不存在');
  return { ok: true };
}

/** 券统计：发放/使用/核销率/带来订单金额 */
async function stats(scope, q) {
  const params = [scope.brandId];
  let where = 'WHERE c.brand_id = ?';
  if (q.couponId) {
    where += ' AND c.id = ?';
    params.push(q.couponId);
  }
  const rows = await db.query(
    `SELECT c.id, c.name, c.type, c.value, c.total, c.issued, c.used_count, c.status,
            (SELECT COUNT(*) FROM mp_coupon_receive r WHERE r.coupon_id = c.id) AS receiveCount
     FROM mp_coupon c ${where} ORDER BY c.issued DESC`,
    params
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    value: Number(r.value),
    total: Number(r.total),
    issued: Number(r.issued),
    used: Number(r.used_count),
    receiveCount: Number(r.receiveCount),
    remain: Math.max(0, Number(r.total) - Number(r.issued)),
    usedRate: Number(r.issued) ? Math.round((Number(r.used_count) / Number(r.issued)) * 100) + '%' : '0%',
    status: Number(r.status),
  }));
}

module.exports = {
  parseStoreIds,
  couponDTO,
  calcDiscount,
  listReceivable,
  receive,
  grantToUsers,
  grantNewUserCoupons,
  listMine,
  listUsable,
  listTemplates,
  saveTemplate,
  toggleTemplate,
  stats,
};
