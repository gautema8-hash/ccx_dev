/**
 * 菜单域（连锁版）
 *
 * 与单店版的本质区别：**菜单是「品牌模板 + 门店覆盖」**
 *   总部维护 mp_dish（卖什么、指导价、是否上架）
 *   门店通过 mp_store_dish 覆盖（本店库存、本店停售、门店改价）
 * 所以这里用 LEFT JOIN 一次取全，COALESCE 出「对本店而言的真正价格与库存」。
 *
 * 缓存：按门店维度缓存（key 带 storeId），商家改价/改库存时会主动失效。
 */
const db = require('../db');
const redis = require('../redis');
const config = require('../config');
const logger = require('../logger');
const geo = require('../geo');
const { bizError, notFound, CODES } = require('../errors');

/** 取门店（未指定则取第一家营业中的门店） */
async function resolveStore(storeId) {
  if (storeId) {
    const s = await db.queryOne('SELECT * FROM mp_store WHERE id = ? AND status = 1', [storeId]);
    if (!s) throw notFound('门店不存在或已停业');
    return s;
  }
  /**
   * 默认门店：直营优先，其次按门店编码升序（BJ001 = 东直门总店，即旗舰店）。
   * 不能按 id 字母序取 —— 那样会落在朝阳店，与「总店是默认门店」的业务预期不符。
   */
  const s = await db.queryOne('SELECT * FROM mp_store WHERE status = 1 ORDER BY (type = \'DIRECT\') DESC, code ASC LIMIT 1');
  if (!s) throw bizError(CODES.NOT_FOUND, '暂无营业中的门店');
  return s;
}

function storeDTO(s, lat, lng) {
  let tables = [];
  try {
    tables = JSON.parse(s.tables_json || '[]');
  } catch (e) {}
  const brand = { id: s.brand_id };
  const dto = {
    id: s.id,
    brandId: s.brand_id,
    code: s.code,
    name: s.name,
    type: s.type,
    typeText: s.type === 'FRANCHISE' ? '加盟店' : '直营店',
    franchisee: s.franchisee || '',
    region: s.region,
    city: s.city,
    address: s.address,
    phone: s.phone,
    latitude: Number(s.latitude),
    longitude: Number(s.longitude),
    openTime: s.open_time,
    perCapita: Number(s.per_capita),
    tables,
    openNow: geo.isOpenNow(s.open_time),
  };
  if (geo.validCoord(lat, lng) && geo.validCoord(s.latitude, s.longitude)) {
    dto.distanceKm = geo.distanceKm(lat, lng, Number(s.latitude), Number(s.longitude));
    dto.distanceText = geo.distanceText(dto.distanceKm);
  }
  return dto;
}

/** 组装菜单（含门店覆盖） */
async function buildMenu(storeId, lat, lng) {
  const store = await resolveStore(storeId);
  const brand = await db.queryOne('SELECT * FROM mp_brand WHERE id = ?', [store.brand_id]);
  if (!brand) throw bizError(CODES.NOT_FOUND, '品牌不存在');

  const [categories, dishes, soups, dips, spicy] = await Promise.all([
    db.query('SELECT id, name, emoji FROM mp_category WHERE brand_id = ? AND status = 1 ORDER BY sort ASC', [brand.id]),
    db.query(
      `SELECT d.id, d.category_id, d.name, d.description, d.emoji, d.image,
              COALESCE(NULLIF(sd.price_override,0), d.price) AS price,
              d.unit, d.spicy, d.tags,
              COALESCE(sd.stock, 0) AS stock, COALESCE(sd.sold, 0) AS sold,
              COALESCE(sd.status, 0) AS store_status
       FROM mp_dish d
       LEFT JOIN mp_store_dish sd ON sd.dish_id = d.id AND sd.store_id = ?
       WHERE d.brand_id = ? AND d.status = 1
       ORDER BY d.sort ASC`,
      [store.id, brand.id]
    ),
    db.query('SELECT id, name, price, emoji, description, recommended FROM mp_soup WHERE brand_id = ? AND status = 1 ORDER BY sort ASC', [brand.id]),
    db.query('SELECT id, name, price, emoji FROM mp_dip WHERE brand_id = ? AND status = 1 ORDER BY sort ASC', [brand.id]),
    db.query('SELECT id, name, color FROM mp_spicy ORDER BY sort ASC'),
  ]);

  const byCat = new Map();
  dishes.forEach((d) => {
    /* 门店未在售（store_status=0 或无覆盖记录）则不展示 */
    if (Number(d.store_status) !== 1) return;
    if (!byCat.has(d.category_id)) byCat.set(d.category_id, []);
    byCat.get(d.category_id).push({
      id: d.id,
      categoryId: d.category_id,
      name: d.name,
      desc: d.description,
      emoji: d.emoji,
      image: d.image,
      price: Number(d.price),
      unit: d.unit,
      spicy: !!d.spicy,
      stock: Number(d.stock),
      sold: Number(d.sold),
      tags: (() => {
        try {
          return JSON.parse(d.tags || '[]');
        } catch (e) {
          return [];
        }
      })(),
      soldOut: Number(d.stock) <= 0,
    });
  });

  const categoriesWithDishes = categories
    .map((c) => Object.assign({}, c, { dishes: byCat.get(c.id) || [] }))
    .filter((c) => c.dishes.length > 0);

  return {
    brand: { id: brand.id, name: brand.name, logo: brand.logo, notice: brand.notice, contact: brand.contact },
    /**
     * 打包费由服务端下发（分）。
     * 不能让小程序自己写死 100 —— 运营一旦在后台改了打包费，
     * 就会出现「页面显示 ¥1、实付 ¥2」的金额争议。
     */
    packFee: config.biz.packFee,
    /** shop 保留原名以兼容小程序既有字段（内容即当前门店） */
    shop: Object.assign(storeDTO(store, lat, lng), {
      logo: brand.logo,
      notice: brand.notice,
      tags: [],
    }),
    store: storeDTO(store, lat, lng),
    categories: categoriesWithDishes,
    soups: soups.map((s) => Object.assign({}, s, { price: Number(s.price), recommended: !!s.recommended })),
    dips: dips.map((d) => Object.assign({}, d, { price: Number(d.price) })),
    spicyOptions: spicy,
    totalDishes: categoriesWithDishes.reduce((n, c) => n + c.dishes.length, 0),
    updatedAt: Date.now(),
  };
}

async function getMenu(ctx) {
  const storeId = ctx.query.storeId || '';
  const lat = ctx.query.lat;
  const lng = ctx.query.lng;
  /* 带坐标时不做缓存（距离随位置变），其余按门店缓存 */
  const cacheKey = 'menu:' + (storeId || 'default');
  if (!geo.validCoord(lat, lng)) {
    const cached = await redis.cache.get(cacheKey);
    if (cached) return ctx.ok(cached);
  }
  const menu = await buildMenu(storeId, lat, lng);
  if (!geo.validCoord(lat, lng)) {
    await redis.cache.set(cacheKey, menu, config.biz.menuCacheTtl);
  }
  return ctx.ok(menu);
}

/** 失效缓存（门店改价/改库存/上下架后调用） */
async function refreshMenuCache(storeId) {
  if (storeId) await redis.cache.del('menu:' + storeId);
  await redis.cache.del('menu:default');
  logger.debug('menu cache invalidated', { storeId: storeId || 'all' });
}

/* ============================================================ 门店（公众端） */
/** 门店列表 / 附近门店 */
async function listStores(ctx) {
  const brandId = ctx.query.brandId || 'brand_lbz';
  const lat = ctx.query.lat;
  const lng = ctx.query.lng;
  const type = ctx.query.type; // DIRECT | FRANCHISE | 空=全部
  const keyword = String(ctx.query.keyword || '').trim();

  const params = [brandId];
  let where = 'WHERE brand_id = ? AND status = 1';
  if (type === 'DIRECT' || type === 'FRANCHISE') {
    where += ' AND type = ?';
    params.push(type);
  }
  if (keyword) {
    where += ' AND (name LIKE ? OR address LIKE ? OR city LIKE ?)';
    params.push('%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%');
  }
  const rows = await db.query(`SELECT * FROM mp_store ${where}`, params);

  let list = rows.map((s) => storeDTO(s, lat, lng));
  const hasCoord = geo.validCoord(lat, lng);
  if (hasCoord) {
    list = list
      .filter((s) => s.distanceKm == null || s.distanceKm <= config.chain.nearbyRadiusKm)
      .sort((a, b) => {
        /* 营业中优先，其次按距离 */
        if (a.openNow !== b.openNow) return a.openNow ? -1 : 1;
        return (a.distanceKm || 0) - (b.distanceKm || 0);
      })
      .slice(0, config.chain.nearbyLimit);
  } else {
    list.sort((a, b) => (b.openNow ? 1 : 0) - (a.openNow ? 1 : 0) || a.id.localeCompare(b.id));
  }

  return ctx.ok({
    list,
    total: list.length,
    center: hasCoord ? { lat: Number(lat), lng: Number(lng) } : null,
    /** 没有坐标时前端可以提示「开启定位查看距你最近的门店」 */
    needLocation: !hasCoord,
  });
}

async function getStore(ctx) {
  const s = await db.queryOne('SELECT * FROM mp_store WHERE id = ?', [ctx.params.id]);
  if (!s) throw notFound('门店不存在');
  const brand = await db.queryOne('SELECT id, name, logo, notice, contact FROM mp_brand WHERE id = ?', [s.brand_id]);
  return ctx.ok(Object.assign(storeDTO(s, ctx.query.lat, ctx.query.lng), { brand }));
}

module.exports = { getMenu, buildMenu, refreshMenuCache, listStores, getStore, resolveStore, storeDTO };
