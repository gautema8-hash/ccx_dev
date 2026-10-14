/**
 * 连锁能力对小程序开放的接口（门店定位 / 主题 / 团购券自助核销 / 领券中心）
 * 与订单、菜单一样走 /miniapp/v1 前缀，鉴权策略按接口性质区分：
 *   · 门店与主题：可选登录（未登录也能看菜单、看门店）
 *   · 领券、核销：必须登录（要落到具体用户）
 */
const db = require('../db');
const config = require('../config');
const logger = require('../logger');
const menuRoute = require('./menu');
const themeService = require('../themeService');
const couponService = require('../couponService');
const voucherService = require('../voucherService');
const geo = require('../geo');
const { bizError, notFound, tooMany, CODES } = require('../errors');

/* ============================================================ 门店（定位） */
/**
 * 附近门店：小程序传 wx.getLocation 拿到的坐标，服务端按 Haversine 排序
 * 未授权定位时也返回门店列表（needLocation=true），前端提示「开启定位看最近门店」
 */
async function nearbyStores(ctx) {
  return menuRoute.listStores(ctx);
}

async function storeDetail(ctx) {
  return menuRoute.getStore(ctx);
}

/* ============================================================ 主题 */
async function getTheme(ctx) {
  const storeId = String(ctx.query.storeId || '').slice(0, 32);
  let brandId = 'brand_lbz';
  if (storeId) {
    const s = await db.queryOne('SELECT brand_id FROM mp_store WHERE id = ?', [storeId]);
    if (s) brandId = s.brand_id;
  }
  const theme = await themeService.resolveTheme(brandId, storeId);
  return ctx.ok({
    themeId: theme.id,
    name: theme.name,
    type: theme.type,
    scope: theme.scope,
    description: theme.description,
    tokens: theme.tokens,
    /** 前端可以直接把 tokens 逐项 setData 成 CSS 变量 */
    style: Object.keys(theme.tokens)
      .map((k) => `--c-${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${theme.tokens[k]}`)
      .join(';'),
    serverTime: Date.now(),
  });
}

/* ============================================================ 领券中心 */
async function couponCenter(ctx) {
  const storeId = String(ctx.query.storeId || '').slice(0, 32);
  const brandId = String(ctx.query.brandId || 'brand_lbz').slice(0, 32);
  const userId = ctx.user ? ctx.user.id : 0;
  const list = await couponService.listReceivable(brandId, storeId, userId);
  return ctx.ok({ list, storeId, total: list.length });
}

async function receiveCoupon(ctx) {
  const couponId = ctx.params.id;
  const storeId = String((ctx.body && ctx.body.storeId) || ctx.query.storeId || '').slice(0, 32);
  /* 领券频次限制：防脚本刷券 */
  const rl = await require('../redis').rateLimit.hit('couponreceive:' + ctx.user.id, 20, 60);
  if (!rl.allowed) throw tooMany('领取过于频繁，请稍后再试');
  const coupon = await couponService.receive(ctx.user.id, couponId, storeId, 'RECEIVE');
  logger.info('coupon received via center', { userId: ctx.user.id, couponId, storeId });
  return ctx.ok(coupon);
}

/** 我的优惠券（支持带订单上下文，返回「能不能用 + 能省多少」） */
async function myCoupons(ctx) {
  const status = ctx.query.status || 'UNUSED';
  const storeId = String(ctx.query.storeId || '').slice(0, 32);
  const goodsAmount = Number(ctx.query.goodsAmount || 0);
  const soupFee = Number(ctx.query.soupFee || 0);
  const withContext = ctx.query.withContext === '1';
  const list = await couponService.listMine(
    ctx.user.id,
    status,
    withContext ? { goodsAmount, soupFee, storeId } : null
  );
  return ctx.ok(list);
}

/** 结算页：只返回当前订单真正可用的券，按能省多少倒序 */
async function usableCoupons(ctx) {
  const storeId = String((ctx.body && ctx.body.storeId) || '');
  const goodsAmount = Number((ctx.body && ctx.body.goodsAmount) || 0);
  const soupFee = Number((ctx.body && ctx.body.soupFee) || 0);
  const list = await couponService.listUsable(ctx.user.id, { goodsAmount, soupFee, storeId });
  const best = list[0] || null;
  return ctx.ok({ list, best, total: list.length });
}

/* ============================================================ 团购券自助核销 */
/**
 * 用户在小程序端自助核销美团团购券
 * 与店员核销**共用 voucherService.verifyVoucher**，只在 channel/userId 上区分
 */
async function verifyVoucherSelf(ctx) {
  const b = ctx.body || {};
  const code = b.code;
  const storeId = String(b.storeId || '').slice(0, 32);
  if (!storeId) throw bizError(CODES.PARAM_INVALID, '请先选择门店');

  const store = await db.queryOne('SELECT * FROM mp_store WHERE id = ? AND status = 1', [storeId]);
  if (!store) throw notFound('门店不存在或已停业');
  if (!geo.isOpenNow(store.open_time)) {
    throw bizError(CODES.STATE_CONFLICT, '门店当前未营业，请在营业时间内核销');
  }

  const result = await voucherService.verifyVoucher({
    code,
    storeId,
    channel: 'SELF',
    userId: ctx.user.id,
    platform: String(b.platform || 'MEITUAN').slice(0, 16),
  });
  logger.info('voucher self verified', { userId: ctx.user.id, storeId, code: String(code).slice(0, 4) + '****' });
  return ctx.ok(result);
}

/** 我的核销记录（含店员代核销的，按手机号/用户维度关联不到，这里只返回自助核销的） */
async function myVouchers(ctx) {
  const rows = await db.query(
    `SELECT v.*, s.name AS store_name FROM mp_voucher v LEFT JOIN mp_store s ON s.id = v.store_id
     WHERE v.user_id = ? ORDER BY v.created_at DESC LIMIT 50`,
    [ctx.user.id]
  );
  return ctx.ok(
    rows.map((r) => ({
      id: r.id,
      code: r.code,
      platform: r.platform,
      storeId: r.store_id,
      storeName: r.store_name,
      productName: r.product_name,
      faceValue: Number(r.face_value),
      faceValueText: (Number(r.face_value) / 100).toFixed(2),
      status: r.status,
      channel: r.channel,
      verifiedAt: Number(r.verified_at),
      verifiedAtText: new Date(Number(r.verified_at)).toLocaleString('zh-CN'),
    }))
  );
}

module.exports = {
  nearbyStores,
  storeDetail,
  getTheme,
  couponCenter,
  receiveCoupon,
  myCoupons,
  usableCoupons,
  verifyVoucherSelf,
  myVouchers,
};
