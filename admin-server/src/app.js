/**
 * 路由装配（管理系统后端）
 * 统一前缀 /miniapp/v1/admin
 *
 * ── 鉴权链路（每个接口都必须走完） ──
 *   ① requireStaff  —— 员工令牌（scrypt 口令换取的 JWT，与小程序用户令牌体系隔离）
 *   ② assertPerm    —— 权限点（能不能做这个动作）
 *   ③ assertStore   —— 门店范围（能在哪家店做）——**独立于权限点，不能省**
 *   ④ audit         —— 写操作留痕
 *
 * ── 与小程序后端的分工 ──
 *   本服务：账号权限、门店/员工/菜品/主题/券模板/审计（纯 CRUD，直连 DB）
 *   下游  ：订单流转、退款、团购券核销、定向发券、门店库存 → 走 internalApi
 *            （这些是领域规则，只有一份实现，复制会导致状态机/防重规则分裂）
 */
const { Server } = require('./http');
const config = require('./config');
const staffAuth = require('./staffAuth');
const rbac = require('./rbac');
const db = require('./db');
const redis = require('./redis');
const logger = require('./logger');

const adminRoute = require('./routes/admin');

function build() {
  const app = new Server();
  const P = config.apiPrefix;
  const staffOnly = staffAuth.requireStaff;

  /* ---------------- 探针 ---------------- */
  app.get('/health', (ctx) => ctx.ok({ status: 'ok', uptime: Math.floor(process.uptime()), inflight: app.inflight }));
  app.get('/ready', async (ctx) => {
    const dbOk = await db.health();
    const redisOk = redis.healthy();
    if (!dbOk) return ctx.send(503, { code: 50300, message: 'database not ready', data: { db: false, redis: redisOk } });
    return ctx.ok({ db: true, redis: redisOk, degraded: !redisOk });
  });
  app.get('/metrics', (ctx) => ctx.ok(Object.assign({ inflight: app.inflight, uptime: process.uptime() }, app.stats)));

  /* ---------------- 认证（不需 staff 令牌） ---------------- */
  app.post(P + '/auth/login', staffAuth.login);
  app.post(P + '/auth/refresh', staffAuth.refresh);

  /* ---------------- 需 staff 令牌 ---------------- */
  app.get(P + '/auth/profile', staffOnly, (ctx) => {
    const meta = rbac.roleMeta(ctx.scope.role) || {};
    return ctx.ok(
      Object.assign(staffAuth.publicStaff(ctx.staff, ctx.scope.storeIds), {
        scope: {
          allStores: ctx.scope.allStores,
          storeIds: ctx.scope.storeIds,
          region: ctx.scope.region,
          roleName: meta.name,
        },
        perms: meta.perms || [],
      })
    );
  });
  app.post(P + '/auth/password', staffOnly, staffAuth.changePassword);
  app.post(P + '/auth/logout', staffOnly, staffAuth.logout);

  /* 品牌 */
  app.get(P + '/brand', staffOnly, adminRoute.getBrand);
  app.put(P + '/brand', staffOnly, adminRoute.saveBrand);

  /* 门店 */
  app.get(P + '/stores', staffOnly, adminRoute.listStores);
  app.post(P + '/stores', staffOnly, adminRoute.saveStore);
  app.post(P + '/stores/:id/status', staffOnly, adminRoute.toggleStore);
  app.post(P + '/stores/:id/sync-menu', staffOnly, adminRoute.syncStoreMenu);

  /* 员工 */
  app.get(P + '/staff', staffOnly, adminRoute.listStaff);
  app.post(P + '/staff', staffOnly, adminRoute.saveStaff);
  app.post(P + '/staff/:id/status', staffOnly, adminRoute.toggleStaff);
  app.post(P + '/staff/:id/reset-password', staffOnly, adminRoute.resetStaffPassword);

  /* 菜单与库存 */
  app.get(P + '/dishes', staffOnly, adminRoute.listDishes);
  app.post(P + '/dishes', staffOnly, adminRoute.saveDish);
  app.post(P + '/dishes/:id/status', staffOnly, adminRoute.toggleDish);
  app.post(P + '/store-dishes', staffOnly, adminRoute.updateStoreDish);

  /* 订单 */
  app.get(P + '/orders', staffOnly, adminRoute.listOrders);
  app.post(P + '/orders/:id/accept', staffOnly, (ctx) => adminRoute.advance(ctx, 'accept'));
  app.post(P + '/orders/:id/cook', staffOnly, (ctx) => adminRoute.advance(ctx, 'cook'));
  app.post(P + '/orders/:id/ready', staffOnly, (ctx) => adminRoute.advance(ctx, 'ready'));
  app.post(P + '/orders/:id/done', staffOnly, (ctx) => adminRoute.advance(ctx, 'done'));
  app.post(P + '/orders/:id/reject', staffOnly, adminRoute.rejectOrder);
  app.get(P + '/refunds', staffOnly, adminRoute.listRefunds);
  app.post(P + '/refunds/:id/approve', staffOnly, adminRoute.approveRefund);
  app.post(P + '/refunds/:id/reject', staffOnly, adminRoute.rejectRefund);
  app.get(P + '/stats', staffOnly, adminRoute.stats);
  app.get(P + '/summary', staffOnly, adminRoute.summary);

  /* 优惠券 */
  app.get(P + '/coupons', staffOnly, adminRoute.listCoupons);
  app.post(P + '/coupons', staffOnly, adminRoute.saveCoupon);
  app.post(P + '/coupons/:id/status', staffOnly, adminRoute.toggleCoupon);
  app.post(P + '/coupons/:id/grant', staffOnly, adminRoute.grantCoupon);
  app.get(P + '/coupon-stats', staffOnly, adminRoute.couponStats);

  /* 主题 */
  app.get(P + '/themes', staffOnly, adminRoute.listThemes);
  app.post(P + '/themes', staffOnly, adminRoute.saveTheme);
  app.post(P + '/themes/:id/activate', staffOnly, adminRoute.activateTheme);
  app.post(P + '/themes/:id/status', staffOnly, adminRoute.toggleTheme);
  app.del(P + '/themes/:id', staffOnly, adminRoute.deleteTheme);

  /* 团购券核销 */
  app.post(P + '/vouchers/verify', staffOnly, adminRoute.verifyVoucher);
  app.get(P + '/vouchers', staffOnly, adminRoute.listVouchers);
  app.post(P + '/vouchers/:id/refund', staffOnly, adminRoute.refundVoucher);

  /* 审计 */
  app.get(P + '/audit', staffOnly, adminRoute.listAudit);
  app.get(P + '/login-logs', staffOnly, adminRoute.listLoginLogs);

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
