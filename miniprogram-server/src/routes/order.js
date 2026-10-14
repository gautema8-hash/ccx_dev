/**
 * 订单域
 *
 * 下单链路（交付级并发设计）：
 *   ① Redis 分布式锁 order:{userId}  → 同一用户并发下单串行化（防连点/双开）
 *   ② 幂等键 Idempotency-Key         → 网络重试不会产生第二笔订单（DB 唯一键兜底）
 *   ③ 服务端重新计价                 → 客户端传上来的 amount 一律丢弃，杜绝改价
 *   ④ 原子扣库存                     → UPDATE ... WHERE stock >= ?，affectedRows=0 即库存不足
 *                                    （不是「先查再减」，所以不存在超卖窗口）
 *   ⑤ 按 dishId 排序后再扣减          → 统一加锁顺序，规避并发死锁
 *   ⑥ 券的核销用条件更新             → WHERE status='UNUSED' 保证一券只能用一次
 *   ⑦ 全程单事务                     → 任一步失败整体回滚，不留脏数据
 */
const db = require('../db');
const auth = require('../auth');
const redis = require('../redis');
const config = require('../config');
const logger = require('../logger');
const menuRoute = require('./menu');
const couponService = require('../couponService');
const { bizError, notFound, unauthorized, tooMany, CODES } = require('../errors');

const ORDER_STATUS = {
  UNPAID: 'UNPAID',
  PAID: 'PAID',
  ACCEPTED: 'ACCEPTED',
  COOKING: 'COOKING',
  READY: 'READY',
  DONE: 'DONE',
  CANCELED: 'CANCELED',
};

/* ------------------------------ 工具 ------------------------------ */
const uid = (prefix) => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/**
 * 订单号：LBZ + yyyyMMdd + 8 位全局递增序列
 * 不用「秒级时间戳 + 随机数」—— 同一秒内并发下单会撞号（3 位随机只有 1000 种，生日悖论秒杀），
 * 而 mp_seq 的 LAST_INSERT_ID 自增是原子的，配合日期天然唯一且可读。
 */
function buildOrderNo(date, seq) {
  const p = (n, len) => String(n).padStart(len || 2, '0');
  return 'LBZ' + date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) + p(seq % 100000000, 8);
}
const toInt = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};

function must(cond, message) {
  if (!cond) throw bizError(CODES.PARAM_INVALID, message);
}

/** DB 行 → 领域模型（与小程序本地模型同形，小程序侧 decorate() 直接复用） */
function toOrderDTO(order, items, timeline) {
  return {
    id: order.id,
    orderNo: order.order_no,
    pickupNo: order.pickup_no,
    /** shopId/shopName 保留原名以兼容小程序既有字段，内容即门店 */
    shopId: order.store_id,
    shopName: order.shop_name || '',
    storeId: order.store_id,
    storeName: order.shop_name || '',
    storeType: order.store_type || 'DIRECT',
    brandId: order.brand_id || '',
    status: order.status,
    diningType: order.dining_type,
    tableNo: order.table_no,
    peopleCount: order.people_count,
    remark: order.remark,
    parentOrderId: order.parent_order_id || '',
    soup: order.soup_id ? { id: order.soup_id, name: order.soup_name, price: order.soup_price } : null,
    dips: (() => {
      try {
        return JSON.parse(order.dip_ids || '[]');
      } catch (e) {
        return [];
      }
    })(),
    items: (items || []).map((i) => ({
      key: i.dish_id + '#' + (i.spicy_id || 'none'),
      dishId: i.dish_id,
      name: i.dish_name,
      emoji: i.emoji,
      price: i.price,
      unit: i.unit,
      count: i.quantity,
      spicyId: i.spicy_id,
      spicyName: i.spicy_name,
      amount: i.amount,
    })),
    amount: {
      goods: order.goods_amount,
      soupFee: order.soup_fee,
      packFee: order.pack_fee,
      discount: order.discount,
      pay: order.pay_amount,
    },
    createTime: Number(order.created_at),
    payTime: Number(order.pay_time),
    updateTime: Number(order.updated_at),
    finishTime: Number(order.finish_time),
    cancelReason: order.cancel_reason || '',
    urgeCount: order.urge_count,
    rated: !!order.rated,
    timeline: timeline || [],
    isMock: false,
  };
}

/** 时间轴步骤定义（与状态机一一对应） */
const TIMELINE_STEPS = [
  { key: ORDER_STATUS.PAID, text: '支付成功' },
  { key: ORDER_STATUS.ACCEPTED, text: '商家接单' },
  { key: ORDER_STATUS.COOKING, text: '开始涮煮' },
  { key: ORDER_STATUS.READY, text: '已上桌 / 可取餐' },
  { key: ORDER_STATUS.DONE, text: '订单完成' },
];
const STATUS_STEP = {
  UNPAID: -1,
  PAID: 0,
  ACCEPTED: 1,
  COOKING: 2,
  READY: 3,
  DONE: 4,
  CANCELED: -1,
};

function fmt(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const p = (n) => (n < 10 ? '0' + n : n);
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/**
 * 构造时间轴视图（前端直接渲染，不再自己推断节点状态）
 * 时间取自 mp_order_log 的真实流转记录，不是估算
 */
async function buildTimeline(order) {
  const logs = await db.query('SELECT to_status, created_at FROM mp_order_log WHERE order_id = ? ORDER BY id ASC', [
    order.id,
  ]);
  const at = {};
  logs.forEach((l) => {
    if (at[l.to_status] === undefined) at[l.to_status] = Number(l.created_at);
  });
  const cur = STATUS_STEP[order.status] === undefined ? -1 : STATUS_STEP[order.status];
  return TIMELINE_STEPS.map((s, i) => {
    const done = i <= cur;
    const time = at[s.key] || 0;
    let text = s.text;
    if (s.key === ORDER_STATUS.READY) text = order.dining_type === 'takeout' ? '可取餐' : '已上桌';
    return { key: s.key, text, time, timeText: done && time ? fmt(time) : '', done, current: i === cur };
  });
}

/** 兼容旧调用 */
async function loadTimeline(orderId) {
  const order = await db.queryOne('SELECT * FROM mp_order WHERE id = ?', [orderId]);
  return order ? buildTimeline(order) : [];
}

function emptyTimeline() {
  return TIMELINE_STEPS.map((s) => ({ key: s.key, text: s.text, time: 0, timeText: '', done: false, current: false }));
}

async function getOrderDetail(orderId, userId) {
  const order = await db.queryOne(
    'SELECT o.*, s.name AS shop_name FROM mp_order o LEFT JOIN mp_store s ON s.id = o.store_id WHERE o.id = ? AND o.user_id = ?',
    [orderId, userId]
  );
  if (!order) throw notFound('订单不存在');
  const items = await db.query('SELECT * FROM mp_order_item WHERE order_id = ? ORDER BY id ASC', [orderId]);
  const timeline = await buildTimeline(order);
  return toOrderDTO(order, items, timeline);
}

/** 状态流转的统一入口，带前置状态条件更新（并发下只会有一个成功） */
async function transition(txApi, orderId, from, to, operator, remark) {
  const r = await txApi.execute(
    'UPDATE mp_order SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
    [to, Date.now(), orderId, from]
  );
  if (r.affectedRows === 0) return false;
  await txApi.execute(
    'INSERT INTO mp_order_log (order_id, from_status, to_status, operator, remark, created_at) VALUES (?,?,?,?,?,?)',
    [orderId, from, to, operator || 'system', remark || '', Date.now()]
  );
  return true;
}

/**
 * 支付成功结算（支付回调 与 Mock 支付 共用同一条路径，保证两种模式下行为一致）
 * 幂等：靠 `WHERE status='UNPAID'` 条件更新，重复回调只会成功一次
 * @returns {boolean} 本次是否真的完成了状态流转
 */
async function settlePaid(orderId, transactionId, amount, remark) {
  return db.tx(async (tx) => {
    const order = await tx.queryOne('SELECT * FROM mp_order WHERE id = ? FOR UPDATE', [orderId]);
    if (!order) throw notFound('订单不存在');
    logger.debug('settlePaid begin', { orderId, status: order.status, paid: amount, expect: order.pay_amount });
    if (order.status !== ORDER_STATUS.UNPAID) {
      /* 已支付/已取消：重复通知，直接忽略（幂等） */
      return false;
    }
    /* 金额必须与订单应付一致，防止「1 分钱支付」被当成全额 */
    if (Number(amount) !== Number(order.pay_amount)) {
      logger.error('pay amount mismatch', { orderId, paid: amount, expect: order.pay_amount, transactionId });
      throw bizError(CODES.AMOUNT_EXCEEDED, '支付金额与订单金额不一致');
    }
    const ok1 = await transition(tx, orderId, ORDER_STATUS.UNPAID, ORDER_STATUS.PAID, 'wechat', remark || '支付成功');
    if (!ok1) return false;
    await tx.execute('UPDATE mp_order SET pay_time = ?, pay_txn_id = ?, updated_at = ? WHERE id = ?', [
      Date.now(), String(transactionId || '').slice(0, 64), Date.now(), orderId,
    ]);
    await tx.execute(
      "UPDATE mp_pay_record SET status='SUCCESS', transaction_id=?, updated_at=? WHERE order_id=? AND status<>'SUCCESS'",
      [String(transactionId || '').slice(0, 64), Date.now(), orderId]
    );
    return true;
  });
}

/* ============================================================ 创建订单 */
async function createOrder(ctx) {
  const user = ctx.user;
  const b = ctx.body || {};
  const idemKey = String(ctx.headers['idempotency-key'] || '').slice(0, 80);

  /* ③ 入参校验（白名单式，未知字段一律忽略） */
  const rawItems = Array.isArray(b.items) ? b.items : [];
  must(rawItems.length > 0, '请先选择菜品');
  must(rawItems.length <= 50, '单笔订单菜品种类过多');
  const normalized = [];
  let itemCount = 0;
  for (const it of rawItems) {
    // 客户端可能传 [null] 或基础类型；不挡住就是 500（实测踩到）
    if (!it || typeof it !== 'object') throw bizError(CODES.PARAM_INVALID, '菜品数据格式不正确');
    const dishId = String(it.dishId || '').slice(0, 32);
    const spicyId = String(it.spicyId || '').slice(0, 16);
    const count = toInt(it.count, 0);
    must(dishId && count > 0 && count <= 99, '菜品数量不合法');
    itemCount += count;
    normalized.push({ dishId, spicyId, count });
  }
  must(itemCount <= 500, '单笔订单件数过多');
  // 合并同 dishId+spicyId（客户端已合并，这里再兜一层）
  const merged = new Map();
  for (const n of normalized) {
    const k = n.dishId + '#' + n.spicyId;
    const cur = merged.get(k);
    if (cur) cur.count += n.count;
    else merged.set(k, Object.assign({}, n));
  }
  const itemList = Array.from(merged.values());

  const diningType = b.diningType === 'takeout' ? 'takeout' : 'dinein';
  const tableNo = diningType === 'dinein' ? String(b.tableNo || '').slice(0, 16) : '';
  const peopleCount = Math.min(20, Math.max(1, toInt(b.peopleCount, 1)));
  const remark = String(b.remark || '').slice(0, 200);
  const soupId = b.soup && b.soup.id ? String(b.soup.id).slice(0, 32) : '';
  const dipIds = Array.isArray(b.dips) ? b.dips.slice(0, 10).map((d) => String((d && d.id) || d).slice(0, 32)).filter(Boolean) : [];
  const couponId = b.coupon && b.coupon.id ? String(b.coupon.id).slice(0, 32) : '';
  const parentOrderId = String(b.parentOrderId || '').slice(0, 40);

  must(soupId, '请先选择锅底');
  if (diningType === 'dinein') must(tableNo, '请选择桌号');

  /* 门店：连锁模式下订单必须归属到具体门店，库存也扣在该门店上 */
  const store = await menuRoute.resolveStore(b.storeId || '');

  /* 幂等：同 key 直接回放上次结果 */
  if (idemKey) {
    const hit = await db.queryOne('SELECT response FROM mp_idempotency WHERE user_id = ? AND idem_key = ?', [user.id, idemKey]);
    if (hit && hit.response) {
      logger.info('order idempotent hit', { requestId: ctx.requestId, uid: user.id });
      return ctx.ok(JSON.parse(hit.response));
    }
  }

  /* 频次限制：只统计「成功下单」，填错表单/库存不足不该消耗用户配额。
     先用 peek 只读判断，创建成功后再 incr 计数 —— 注意必须放在拿锁之前，
     否则抛错会漏掉锁释放。 */
  const rateKey = 'orderqty:' + user.id;
  const rl = await redis.rateLimit.peek(rateKey, config.biz.orderRateLimit, 900);
  if (!rl.allowed) {
    throw tooMany(`下单过于频繁，请 ${Math.ceil(rl.resetSec / 60)} 分钟后再试`);
  }

  /* ② 同一用户下单串行化，锁 8 秒 */
  const lockKey = 'order:' + user.id;
  const lockToken = await redis.lock.acquire(lockKey, 8000);
  if (!lockToken) throw tooMany('上一笔订单还在处理中，请稍候');

  const orderId = uid('O');
  /* 取餐号（按天循环 A01~A99）与订单号都在事务外先取好，
     避免事务内再占用一条池连接（池耗尽风险），同时保证订单号全局唯一 */
  const now0 = new Date();
  /* 取餐号按「门店 + 日期」独立循环：连锁多店共用一个号池会串号 */
  const dayKey = 'pickup:' + store.id + ':' + now0.toISOString().slice(0, 10);
  const seq = await db.nextSeq(dayKey, 99);
  const pickupNo = 'A' + (seq < 10 ? '0' + seq : seq);
  const orderNo = buildOrderNo(now0, await db.nextSeq('orderno'));

  try {
    const result = await db.tx(async (tx) => {
      /* 读取菜品真实价格与门店库存（价格取门店覆盖价，绝不信客户端） */
      const ids = itemList.map((i) => i.dishId);
      const placeholders = ids.map(() => '?').join(',');
      const dishes = await tx.query(
        `SELECT d.id, d.name, d.emoji, d.unit, d.spicy, d.brand_id,
                COALESCE(NULLIF(sd.price_override, 0), d.price) AS price,
                COALESCE(sd.stock, 0) AS stock,
                COALESCE(sd.status, 0) AS store_status
         FROM mp_dish d
         LEFT JOIN mp_store_dish sd ON sd.dish_id = d.id AND sd.store_id = ?
         WHERE d.id IN (${placeholders})`,
        [store.id].concat(ids)
      );
      const dishMap = new Map(dishes.map((d) => [d.id, d]));
      for (const it of itemList) {
        const d = dishMap.get(it.dishId);
        must(d, '菜品已下架：' + it.dishId);
        must(d.brand_id === store.brand_id, '菜品不属于该品牌');
        must(Number(d.store_status) === 1, '本店已停售：' + d.name);
        must(d.spicy ? !!it.spicyId : true, '请选择辣度：' + d.name);
      }

      /* 锅底（同品牌） */
      const soup = await tx.queryOne('SELECT * FROM mp_soup WHERE id = ? AND status = 1 AND brand_id = ?', [soupId, store.brand_id]);
      must(soup, '锅底不可用，请重新选择');

      /* 蘸料 */
      let dips = [];
      if (dipIds.length) {
        const ph = dipIds.map(() => '?').join(',');
        dips = await tx.query(`SELECT id, name FROM mp_dip WHERE id IN (${ph}) AND status = 1`, dipIds);
      }

      /* ④⑤ 原子扣门店库存：按 dishId 排序统一加锁顺序，避免死锁 */
      const sorted = itemList.slice().sort((a, b2) => (a.dishId < b2.dishId ? -1 : a.dishId > b2.dishId ? 1 : 0));
      for (const it of sorted) {
        const d = dishMap.get(it.dishId);
        const r = await tx.execute(
          `UPDATE mp_store_dish SET stock = stock - ?, sold = sold + ?, updated_at = ?
           WHERE store_id = ? AND dish_id = ? AND status = 1 AND stock >= ?`,
          [it.count, it.count, Date.now(), store.id, it.dishId, it.count]
        );
        if (r.affectedRows === 0) {
          throw bizError(CODES.STOCK_NOT_ENOUGH, `「${d.name}」库存不足，请调整数量后重试`);
        }
      }

      /* 服务端计价 */
      const pricedItems = itemList.map((it) => {
        const d = dishMap.get(it.dishId);
        return {
          dishId: it.dishId,
          dishName: d.name,
          emoji: d.emoji,
          price: d.price,
          unit: d.unit,
          quantity: it.count,
          spicyId: it.spicyId,
          spicyName: '',
          amount: d.price * it.count,
        };
      });
      const goodsAmount = pricedItems.reduce((s, i) => s + i.amount, 0);
      const soupFee = soup.price;
      const packFee = diningType === 'takeout' ? config.biz.packFee : 0;
      const gross = goodsAmount + soupFee + packFee;

      /* 券核销：抵扣口径统一走 couponService.calcDiscount（含门店适用范围 + 折扣券）
         uc.id 必须显式起别名，否则 c.* 里的 id 会把它覆盖掉 */
      let discount = 0;
      let couponUsedId = '';
      if (couponId) {
        const uc = await tx.queryOne(
          `SELECT uc.id AS uc_row_id, c.*
           FROM mp_user_coupon uc JOIN mp_coupon c ON c.id = uc.coupon_id
           WHERE uc.user_id = ? AND uc.coupon_id = ? AND uc.status = 'UNUSED' LIMIT 1`,
          [user.id, couponId]
        );
        if (!uc) throw bizError(CODES.COUPON_UNAVAILABLE, '优惠券不可用');
        const calc = couponService.calcDiscount(uc, { goodsAmount, soupFee, storeId: store.id });
        if (!calc.ok) throw bizError(CODES.COUPON_UNAVAILABLE, calc.reason);
        discount = calc.discount;
        const r = await tx.execute(
          `UPDATE mp_user_coupon SET status = 'USED', order_id = ?, used_at = ? WHERE id = ? AND status = 'UNUSED'`,
          [orderId, Date.now(), uc.uc_row_id]
        );
        if (r.affectedRows === 0) throw bizError(CODES.COUPON_UNAVAILABLE, '优惠券已被使用');
        await tx.execute('UPDATE mp_coupon SET used_count = used_count + 1, updated_at = ? WHERE id = ?', [Date.now(), couponId]);
        couponUsedId = couponId;
      }

      const payAmount = Math.max(0, gross - discount);
      must(payAmount <= config.biz.maxOrderAmount, '订单金额超出限制');

      const now = Date.now();
      await tx.execute(
        `INSERT INTO mp_order
         (id,order_no,user_id,brand_id,store_id,store_type,status,dining_type,table_no,people_count,remark,
          soup_id,soup_name,soup_price,dip_ids,dip_names,item_count,
          goods_amount,soup_fee,pack_fee,discount,pay_amount,coupon_id,pickup_no,
          parent_order_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          orderId, orderNo, user.id, store.brand_id, store.id, store.type,
          ORDER_STATUS.UNPAID, diningType, tableNo, peopleCount, remark,
          soup.id, soup.name, soup.price,
          JSON.stringify(dips.map((d) => ({ id: d.id, name: d.name }))),
          dips.map((d) => d.name).join('、'), itemCount,
          goodsAmount, soupFee, packFee, discount, payAmount, couponUsedId, pickupNo,
          parentOrderId, now, now,
        ]
      );

      for (const p of pricedItems) {
        await tx.execute(
          `INSERT INTO mp_order_item (order_id,dish_id,dish_name,emoji,price,unit,quantity,spicy_id,spicy_name,amount)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [orderId, p.dishId, p.dishName, p.emoji, p.price, p.unit, p.quantity, p.spicyId, p.spicyName, p.amount]
        );
      }
      await tx.execute(
        'INSERT INTO mp_order_log (order_id, from_status, to_status, operator, remark, created_at) VALUES (?,?,?,?,?,?)',
        [orderId, '', ORDER_STATUS.UNPAID, 'user', '下单', now]
      );

      /* 辣度名称回填（mp_spicy 字典） */
      const spicyRows = await tx.query('SELECT id, name FROM mp_spicy');
      const spicyMap = new Map(spicyRows.map((s) => [s.id, s.name]));
      for (const p of pricedItems) {
        if (p.spicyId && spicyMap.has(p.spicyId)) {
          await tx.execute('UPDATE mp_order_item SET spicy_name = ? WHERE order_id = ? AND dish_id = ? AND spicy_id = ?', [
            spicyMap.get(p.spicyId), orderId, p.dishId, p.spicyId,
          ]);
        }
      }

      const items = await tx.query('SELECT * FROM mp_order_item WHERE order_id = ? ORDER BY id ASC', [orderId]);
      const orderRow = await tx.queryOne('SELECT o.*, s.name AS shop_name FROM mp_order o LEFT JOIN mp_store s ON s.id=o.store_id WHERE o.id = ?', [orderId]);
      return toOrderDTO(orderRow, items, emptyTimeline());
    });

    /* 幂等结果必须在响应之前落库，否则紧跟其后的重试会漏判（原先 fire-and-forget 就是这里出问题） */
    if (idemKey) {
      await db
        .execute('INSERT INTO mp_idempotency (user_id, idem_key, response, created_at) VALUES (?,?,?,?)', [
          user.id, idemKey, JSON.stringify(result), Date.now(),
        ])
        .catch((e) => logger.warn('idempotency save failed', { message: e.message }));
    }
    logger.info('order created', { requestId: ctx.requestId, orderNo: result.orderNo, payAmount: result.amount.pay });
    /* 下单成功才计数（配合上面的 peek） */
    await redis.rateLimit.incr(rateKey, 900);

    /* 全额抵扣（应付 0 元）：不需要收银台，直接置为已支付 */
    if (result.amount.pay === 0) {
      await settlePaid(orderId, 'FREE_' + result.orderNo, 0, '优惠券全额抵扣');
      const dto = await getOrderDetail(orderId, user.id);
      if (idemKey) {
        await db
          .execute('UPDATE mp_idempotency SET response = ? WHERE user_id = ? AND idem_key = ?', [
            JSON.stringify(dto), user.id, idemKey,
          ])
          .catch(() => {});
      }
      return ctx.ok(dto);
    }
    return ctx.ok(result);
  } finally {
    await redis.lock.release(lockKey, lockToken);
  }
}

/* ============================================================ 订单列表 */
async function listOrders(ctx) {
  const user = ctx.user;
  const filter = ctx.query.filter || 'all';
  /* 惰性清理：只看自己的、只清少量，避免一个用户的请求扫全表 */
  await closeExpiredOrders({ userId: user.id, limit: 20 });
  /* 分页必须双向兜底：page 只做下限会让 page=1e308 变成 OFFSET 1e308（查询直接炸） */
  const page = Math.min(10000, Math.max(1, toInt(ctx.query.page, 1)));
  const size = Math.min(20, Math.max(1, toInt(ctx.query.size, 10)));

  let where = 'o.user_id = ?';
  if (filter === 'ongoing') where += " AND o.status NOT IN ('DONE','CANCELED')";
  else if (filter === 'done') where += " AND o.status IN ('DONE','CANCELED')";

  const rows = await db.query(
    `SELECT o.*, s.name AS shop_name FROM mp_order o LEFT JOIN mp_store s ON s.id=o.store_id
     WHERE ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
    [user.id, size, (page - 1) * size]
  );
  if (!rows.length) return ctx.ok([]);

  /* 一次把明细查出来再分组，避免 N+1 */
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const items = await db.query(`SELECT * FROM mp_order_item WHERE order_id IN (${ph}) ORDER BY id ASC`, ids);
  const grouped = new Map();
  items.forEach((i) => {
    if (!grouped.has(i.order_id)) grouped.set(i.order_id, []);
    grouped.get(i.order_id).push(i);
  });

  return ctx.ok(rows.map((r) => toOrderDTO(r, grouped.get(r.id) || [], [])));
}

async function getOrder(ctx) {
  /* 惰性清理：用户查看自己的订单时，顺手把已超时的未支付单关掉（回滚库存与券） */
  const own = await db.queryOne('SELECT id, status, created_at FROM mp_order WHERE id = ? AND user_id = ?', [
    ctx.params.id, ctx.user.id,
  ]);
  if (own && own.status === ORDER_STATUS.UNPAID && isPayExpired(own)) {
    await closeUnpaidOrder(own.id, 'system', '超时未支付自动关闭');
  }

  const dto = await getOrderDetail(ctx.params.id, ctx.user.id);
  if (dto.status === ORDER_STATUS.UNPAID) {
    const rec = await db.queryOne('SELECT status FROM mp_pay_record WHERE order_id = ? ORDER BY id DESC LIMIT 1', [dto.id]);
    dto.payChannelStatus = rec ? rec.status : '';
  }
  return ctx.ok(dto);
}

/* ============================================================ 取消 / 超时关单 */
/**
 * 关闭一笔「未支付」订单：状态流转 + 回滚门店库存 + 退回优惠券 + 关闭支付单
 *
 * 抽成独立函数的原因：用户主动取消、支付超时自动关单、后台定时清理
 * 三条路径必须走**完全相同的回滚逻辑**——只要有一处漏回滚，
 * 就会出现「订单取消了但库存没释放」的脏数据，最终表现为"明明有货却显示售罄"。
 *
 * @param {string} orderId
 * @param {string} operator 操作者标识（写状态流转日志）
 * @param {string} reason
 * @returns {Promise<boolean>} 是否实际关闭（false = 订单不存在或状态已变更，属幂等未命中）
 */
async function closeUnpaidOrder(orderId, operator, reason) {
  const order = await db.queryOne('SELECT * FROM mp_order WHERE id = ?', [orderId]);
  if (!order || order.status !== ORDER_STATUS.UNPAID) return false;

  await db.tx(async (tx) => {
    /* 条件更新：并发下只有一个能成功，重复关单不会二次回滚库存 */
    const ok1 = await transition(tx, orderId, ORDER_STATUS.UNPAID, ORDER_STATUS.CANCELED, operator, reason);
    if (!ok1) throw bizError(CODES.STATE_CONFLICT, '订单状态已变更，请刷新后重试');
    await tx.execute('UPDATE mp_order SET cancel_time = ?, cancel_reason = ?, updated_at = ? WHERE id = ?', [
      Date.now(), reason, Date.now(), orderId,
    ]);
    /* 回滚门店库存 */
    const items = await tx.query('SELECT dish_id, quantity FROM mp_order_item WHERE order_id = ?', [orderId]);
    for (const it of items) {
      await tx.execute(
        'UPDATE mp_store_dish SET stock = stock + ?, sold = GREATEST(sold - ?, 0), updated_at = ? WHERE store_id = ? AND dish_id = ?',
        [it.quantity, it.quantity, Date.now(), order.store_id, it.dish_id]
      );
    }
    /* 券退回 */
    if (order.coupon_id) {
      await tx.execute(
        "UPDATE mp_user_coupon SET status = 'UNUSED', order_id = '', used_at = 0 WHERE order_id = ? AND status = 'USED'",
        [orderId]
      );
    }
    await tx.execute("UPDATE mp_pay_record SET status = 'CLOSED', updated_at = ? WHERE order_id = ? AND status = 'CREATED'", [
      Date.now(), orderId,
    ]);
  });
  return true;
}

/** 订单是否已支付超时 */
function isPayExpired(order) {
  return Date.now() - Number(order.created_at) > config.pay.timeoutMin * 60000;
}

/**
 * 批量关闭超时未支付的订单（惰性 + 定时两条路径共用）
 *
 * 为什么必须有：下单时已经原子扣了库存。如果只提示「订单已超时请重新下单」
 * 而不真正关单，库存就会被永远不会支付的脏单一直占着，前端表现为"售罄"。
 *
 * @param {object} opt { storeId?, userId?, limit? }
 * @returns {Promise<number>} 实际关闭笔数
 */
async function closeExpiredOrders(opt) {
  opt = opt || {};
  const limit = Math.min(200, Math.max(1, Number(opt.limit) || 50));
  const deadline = Date.now() - config.pay.timeoutMin * 60000;
  const params = [ORDER_STATUS.UNPAID, deadline];
  let where = 'WHERE status = ? AND created_at < ?';
  if (opt.storeId) {
    where += ' AND store_id = ?';
    params.push(opt.storeId);
  }
  if (opt.userId) {
    where += ' AND user_id = ?';
    params.push(opt.userId);
  }
  const rows = await db.query(`SELECT id FROM mp_order ${where} ORDER BY created_at ASC LIMIT ?`, params.concat([limit]));
  let n = 0;
  for (const r of rows) {
    try {
      if (await closeUnpaidOrder(r.id, 'system', '超时未支付自动关闭')) n++;
    } catch (e) {
      /* 单笔失败不阻断整批（可能是并发下的状态已变更） */
      logger.warn('expire order skipped', { orderId: r.id, message: e && e.message });
    }
  }
  if (n) logger.info('orders expired', { count: n });
  return n;
}

async function cancelOrder(ctx) {
  const user = ctx.user;
  const orderId = ctx.params.id;
  const reason = String((ctx.body && ctx.body.reason) || '用户主动取消').slice(0, 100);

  const order = await db.queryOne('SELECT * FROM mp_order WHERE id = ? AND user_id = ?', [orderId, user.id]);
  if (!order) throw notFound('订单不存在');
  /**
   * 只有「未支付」允许直接取消。
   * 已支付订单如果也能直接取消，就会变成「订单取消了但钱没退」—— 这是资金安全问题，
   * 必须走退款流程（applyRefund），由门店审核后原路退回。
   */
  must(
    order.status === ORDER_STATUS.UNPAID,
    '未支付订单可直接取消；已支付订单请点「申请退款」'
  );

  await closeUnpaidOrder(orderId, 'user', reason);
  logger.info('order canceled', { requestId: ctx.requestId, orderId });
  return ctx.ok(await getOrderDetail(orderId, user.id));
}

/* ============================================================ 完成 */
async function finishOrder(ctx) {
  const user = ctx.user;
  const orderId = ctx.params.id;
  const order = await db.queryOne('SELECT * FROM mp_order WHERE id = ? AND user_id = ?', [orderId, user.id]);
  if (!order) throw notFound('订单不存在');
  must(order.status === ORDER_STATUS.READY || order.status === ORDER_STATUS.COOKING || order.status === ORDER_STATUS.ACCEPTED,
    '当前状态不可确认完成');

  await db.tx(async (tx) => {
    const ok1 = await transition(tx, orderId, order.status, ORDER_STATUS.DONE, 'user', '用户确认完成');
    must(ok1, '订单状态已变更，请刷新后重试');
    await tx.execute('UPDATE mp_order SET finish_time = ?, updated_at = ? WHERE id = ?', [Date.now(), Date.now(), orderId]);
    /* 消费积分：1 元 = 1 分 */
    const gain = Math.floor(order.pay_amount / 100);
    if (gain > 0) {
      await tx.execute('UPDATE mp_user SET points = points + ?, updated_at = ? WHERE id = ?', [gain, Date.now(), user.id]);
    }
  });
  await auth.invalidateUser(user.id);
  return ctx.ok(await getOrderDetail(orderId, user.id));
}

/* ============================================================ 催单 */
async function urgeOrder(ctx) {
  const user = ctx.user;
  const orderId = ctx.params.id;
  const order = await db.queryOne('SELECT * FROM mp_order WHERE id = ? AND user_id = ?', [orderId, user.id]);
  if (!order) throw notFound('订单不存在');
  must(
    [ORDER_STATUS.PAID, ORDER_STATUS.ACCEPTED, ORDER_STATUS.COOKING].indexOf(order.status) > -1,
    '当前状态无需催单'
  );
  /* 催单限流：同一订单 2 分钟内只能催一次 */
  const r = await redis.rateLimit.hit('urge:' + orderId, 1, 120);
  if (!r.allowed) throw tooMany('已催过啦，后厨正在加速~');

  await db.tx(async (tx) => {
    await tx.execute('UPDATE mp_order SET urge_count = urge_count + 1, last_urge_at = ?, updated_at = ? WHERE id = ?', [
      Date.now(), Date.now(), orderId,
    ]);
    await tx.execute(
      'INSERT INTO mp_order_log (order_id, from_status, to_status, operator, remark, created_at) VALUES (?,?,?,?,?,?)',
      [orderId, order.status, order.status, 'user', '催单', Date.now()]
    );
  });
  return ctx.ok({ urgeCount: order.urge_count + 1 });
}

/* ============================================================ 评价 */
async function feedback(ctx) {
  const user = ctx.user;
  const orderId = ctx.params.id;
  const score = Math.min(5, Math.max(1, toInt(ctx.body && ctx.body.score, 5)));
  const content = String((ctx.body && ctx.body.content) || '').slice(0, 500);

  const order = await db.queryOne('SELECT * FROM mp_order WHERE id = ? AND user_id = ?', [orderId, user.id]);
  if (!order) throw notFound('订单不存在');
  must(order.status === ORDER_STATUS.DONE, '订单完成后才能评价');
  must(!order.rated, '该订单已评价过');

  await db.tx(async (tx) => {
    await tx.execute('INSERT INTO mp_feedback (order_id, user_id, score, content, created_at) VALUES (?,?,?,?,?)', [
      orderId, user.id, score, content, Date.now(),
    ]);
    await tx.execute('UPDATE mp_order SET rated = 1, updated_at = ? WHERE id = ? AND rated = 0', [Date.now(), orderId]);
  });
  return ctx.ok({ ok: true });
}

/* ============================================================ 退款申请 */
async function applyRefund(ctx) {
  const user = ctx.user;
  const orderId = ctx.params.id;
  const reason = String((ctx.body && ctx.body.reason) || '用户申请退款').slice(0, 200);

  const order = await db.queryOne('SELECT * FROM mp_order WHERE id = ? AND user_id = ?', [orderId, user.id]);
  if (!order) throw notFound('订单不存在');
  must(order.status === ORDER_STATUS.PAID || order.status === ORDER_STATUS.ACCEPTED, '当前状态不可申请退款（出餐后请联系门店）');
  const exist = await db.queryOne("SELECT id FROM mp_refund WHERE order_id = ? AND status IN ('APPLIED','APPROVED')", [orderId]);
  must(!exist, '退款申请已提交，请耐心等待');

  await db.tx(async (tx) => {
    await tx.execute(
      'INSERT INTO mp_refund (order_id, user_id, amount, reason, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [orderId, user.id, order.pay_amount, reason, 'APPLIED', Date.now(), Date.now()]
    );
    await tx.execute(
      'INSERT INTO mp_order_log (order_id, from_status, to_status, operator, remark, created_at) VALUES (?,?,?,?,?,?)',
      [orderId, order.status, order.status, 'user', '申请退款：' + reason, Date.now()]
    );
  });
  return ctx.ok({ ok: true, amount: order.pay_amount });
}

module.exports = {
  ORDER_STATUS,
  settlePaid,
  loadTimeline,
  buildTimeline,
  emptyTimeline,
  createOrder,
  listOrders,
  getOrder,
  cancelOrder,
  closeUnpaidOrder,
  closeExpiredOrders,
  isPayExpired,
  finishOrder,
  urgeOrder,
  feedback,
  applyRefund,
  getOrderDetail,
  toOrderDTO,
  transition,
};
