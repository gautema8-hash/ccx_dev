/**
 * 路由装配（连锁版）
 * 统一前缀 /miniapp/v1
 *
 * 鉴权分层：
 *   公开          —— 健康检查、登录、菜单、门店、主题、支付回调
 *   optionalAuth —— 菜单/门店/主题（未登录也能浏览）
 *   requireAuth   —— 用户维度的接口（订单、券、核销、资料）
 */
const { Server } = require('./http');
const config = require('./config');
const auth = require('./auth');
const db = require('./db');
const redis = require('./redis');
const logger = require('./logger');
const { unauthorized } = require('./errors');

const orderRoute = require('./routes/order');
const payRoute = require('./routes/pay');
const menuRoute = require('./routes/menu');
const userRoute = require('./routes/user');
const chainRoute = require('./routes/chain');
const internalRoute = require('./routes/internal');

/**
 * 内部接口守卫
 * 未配置 INTERNAL_TOKEN 时一律拒绝 —— 空串会让「随便谁都能调」，比拒绝更危险。
 */
function internalGuard(ctx) {
  const token = String(ctx.headers['x-internal-token'] || '');
  if (!config.internal.token) throw unauthorized('内部接口未启用（INTERNAL_TOKEN 未配置）');
  if (!token || token !== config.internal.token) throw unauthorized('内部令牌无效');
}

function build() {
  const app = new Server();
  const P = config.apiPrefix;

  /* ---------------- 探针与指标 ---------------- */
  app.get('/health', (ctx) => ctx.ok({ status: 'ok', uptime: Math.floor(process.uptime()), inflight: app.inflight }));
  app.get('/ready', async (ctx) => {
    const dbOk = await db.health();
    const redisOk = redis.healthy();
    if (!dbOk) return ctx.send(503, { code: 50300, message: 'database not ready', data: { db: false, redis: redisOk } });
    return ctx.ok({ db: true, redis: redisOk, degraded: !redisOk });
  });
  app.get('/metrics', (ctx) => ctx.ok(Object.assign({ inflight: app.inflight, uptime: process.uptime() }, app.stats)));

  /* ---------------- 登录 ---------------- */
  app.post(P + '/auth/wechat-login', userRoute.login);
  app.post(P + '/auth/refresh', userRoute.refresh);
  app.post(P + '/auth/logout', auth.requireAuth, userRoute.logout);

  /* ---------------- 公众：菜单 / 门店 / 主题 ---------------- */
  app.get(P + '/menu', auth.optionalAuth, menuRoute.getMenu);
  app.get(P + '/stores', auth.optionalAuth, chainRoute.nearbyStores);
  app.get(P + '/stores/:id', auth.optionalAuth, chainRoute.storeDetail);
  app.get(P + '/theme', auth.optionalAuth, chainRoute.getTheme);

  /* ---------------- 用户：资料 / 发票 ---------------- */
  app.get(P + '/user/profile', auth.requireAuth, userRoute.me);
  app.put(P + '/user/profile', auth.requireAuth, userRoute.updateProfile);
  app.post(P + '/user/phone', auth.requireAuth, userRoute.bindPhone);
  app.post(P + '/user/avatar', auth.requireAuth, userRoute.uploadAvatar);
  app.get(P + '/user/stats', auth.requireAuth, userRoute.stats);
  app.get(P + '/user/invoice', auth.requireAuth, userRoute.listInvoice);
  app.post(P + '/user/invoice', auth.requireAuth, userRoute.saveInvoice);
  app.del(P + '/user/invoice/:id', auth.requireAuth, userRoute.deleteInvoice);

  /* ---------------- 用户：优惠券（连锁版） ---------------- */
  app.get(P + '/user/coupons', auth.requireAuth, chainRoute.myCoupons);
  app.get(P + '/coupons/center', auth.optionalAuth, chainRoute.couponCenter);
  app.post(P + '/coupons/:id/receive', auth.requireAuth, chainRoute.receiveCoupon);
  app.post(P + '/coupons/usable', auth.requireAuth, chainRoute.usableCoupons);

  /* ---------------- 用户：团购券核销 ---------------- */
  app.post(P + '/voucher/verify', auth.requireAuth, chainRoute.verifyVoucherSelf);
  app.get(P + '/voucher/mine', auth.requireAuth, chainRoute.myVouchers);

  /* ---------------- 订单 ---------------- */
  app.post(P + '/orders', auth.requireAuth, orderRoute.createOrder);
  app.get(P + '/orders', auth.requireAuth, orderRoute.listOrders);
  app.get(P + '/orders/:id', auth.requireAuth, orderRoute.getOrder);
  app.post(P + '/orders/:id/cancel', auth.requireAuth, orderRoute.cancelOrder);
  app.post(P + '/orders/:id/finish', auth.requireAuth, orderRoute.finishOrder);
  app.post(P + '/orders/:id/urge', auth.requireAuth, orderRoute.urgeOrder);
  app.post(P + '/orders/:id/feedback', auth.requireAuth, orderRoute.feedback);
  app.post(P + '/orders/:id/refund', auth.requireAuth, orderRoute.applyRefund);

  /* ---------------- 支付 ---------------- */
  app.post(P + '/orders/:id/prepay', auth.requireAuth, payRoute.prepay);
  app.post(P + '/orders/:id/mock-pay', auth.requireAuth, payRoute.mockPay);
  app.post(P + '/orders/:id/query-pay', auth.requireAuth, payRoute.queryPay);
  app.post(P + '/pay/notify', payRoute.notify);

  /* ---------------- 内部服务接口（仅管理系统后端可调用，见 internalGuard） ---------------- */
  const internalOnly = internalGuard;
  app.get('/internal/orders', internalOnly, internalRoute.listOrders);
  app.get('/internal/orders/:id', internalOnly, internalRoute.getOrder);
  app.post('/internal/orders/:id/advance', internalOnly, internalRoute.advanceOrder);
  app.post('/internal/orders/:id/reject', internalOnly, internalRoute.rejectOrder);
  app.post('/internal/refunds/:id/approve', internalOnly, internalRoute.approveRefund);
  app.post('/internal/refunds/:id/reject', internalOnly, internalRoute.rejectRefund);
  app.post('/internal/vouchers/verify', internalOnly, internalRoute.verifyVoucher);
  app.post('/internal/vouchers/:id/refund', internalOnly, internalRoute.refundVoucher);
  app.post('/internal/coupons/:id/grant', internalOnly, internalRoute.grantCoupon);
  app.post('/internal/store-dishes', internalOnly, internalRoute.updateStoreDishes);
  app.post('/internal/dishes/:id/status', internalOnly, internalRoute.toggleStoreDish);
  app.post('/internal/menu-cache/invalidate', internalOnly, internalRoute.invalidateMenuCache);

  /* ---------------- 静态资源 ---------------- */
  app.get('/uploads/:a/:b', userRoute.serveUpload);
  app.get('/uploads/:a', userRoute.serveUpload);

  /* 兜底：任何未被捕获的 async 异常都不允许冒泡到进程 */
  process.on('unhandledRejection', (e) => {
    logger.error('unhandledRejection', {
      message: e && e.message,
      stack: e && e.stack ? String(e.stack).split('\n').slice(0, 5).join(' | ') : '',
    });
  });

  return app;
}

module.exports = { build };
