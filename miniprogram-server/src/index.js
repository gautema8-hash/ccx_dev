/**
 * 服务入口
 * 交付级启动/退出行为：
 *   · 生产环境缺配置直接拒绝启动（带病上线比启动失败危险）
 *   · uncaughtException / unhandledRejection 全部落日志；前者触发优雅退出（进程已不可信）
 *   · SIGTERM/SIGINT：先摘流量 → 等在途请求跑完 → 关连接池 → 退出（K8s 滚动发布不丢请求）
 *   · 退出超时强制 kill，避免僵死
 */
const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const redis = require('./redis');
const { build } = require('./app');

const problems = config.assertProductionReady();
if (problems.length) {
  problems.forEach((p) => logger.error('启动前检查未通过: ' + p));
  process.exit(1);
}

let shuttingDown = false;

async function main() {
  db.init();
  redis.init();
  /* 等 Redis 就绪（最多 2s），避免「已开始接请求但缓存/限流还没上班」的窗口 */
  await redis.waitReady(2000);

  /* 启动即校验数据库连通，避免「服务起来了但一调就 500」 */
  const dbOk = await db.health();
  if (!dbOk) {
    logger.error('数据库连接失败，请检查 DB_* 配置与 MySQL 是否启动');
    process.exit(1);
  }

  const app = build();
  const addr = await app.listen(config.port, config.host);

  logger.info('server started', {
    env: config.env,
    addr: config.host + ':' + addr.port,
    apiPrefix: config.apiPrefix,
    loginMode: config.wx.loginMode,
    payMode: config.pay.mode,
    redis: redis.healthy() ? 'on' : 'degraded(off)',
    dbConnLimit: config.db.connectionLimit,
    maxInflight: config.maxInflight,
  });

  if (!redis.healthy()) {
    logger.warn('Redis 不可用，已降级运行：菜单不走缓存、限流与锁退化为进程内实现');
  }

  /* ---------------- 超时未支付订单清理 ---------------- */
  /**
   * 下单时已原子扣库存，未支付订单放着不管就会一直占着库存（前端表现为"售罄"）。
   * 这里做定时兜底（每 60s 一批），配合 prepay / 订单查询的惰性清理。
   * 关单用条件更新（status='UNPAID'），多实例同时跑也只会有一个成功，天然幂等。
   */
  const orderRoute = require('./routes/order');
  const expireTimer = setInterval(() => {
    if (shuttingDown) return;
    orderRoute.closeExpiredOrders({ limit: 100 }).catch((e) => {
      logger.warn('expire sweep failed', { message: e && e.message });
    });
  }, 60000);
  expireTimer.unref();

  /* ---------------- 退出 ---------------- */
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(expireTimer);
    logger.info('shutdown begin', { signal, inflight: app.inflight });

    const force = setTimeout(() => {
      logger.error('shutdown timeout, force exit');
      process.exit(1);
    }, 15000);
    force.unref();

    try {
      await app.close(10000);
      await redis.quit();
      await db.close();
      logger.info('shutdown done');
      clearTimeout(force);
      process.exit(0);
    } catch (e) {
      logger.error('shutdown error', { message: e.message });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (e) => {
    logger.error('uncaughtException', {
      message: e && e.message,
      stack: e && e.stack ? String(e.stack).split('\n').slice(0, 8).join(' | ') : '',
    });
    /* 进程状态已不可信，必须退出让编排器重启；不在这里继续服务 */
    shutdown('uncaughtException');
  });

  return app;
}

main().catch((e) => {
  logger.error('bootstrap failed', { message: e && e.message, stack: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join(' | ') : '' });
  process.exit(1);
});
