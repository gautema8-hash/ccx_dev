/**
 * 服务入口（管理系统后端）
 *
 * 交付级启动/退出行为：
 *   · 生产环境缺配置直接拒绝启动（带病上线比启动失败危险）
 *   · 启动即校验 DB 连通，避免「服务起来了但一调就 500」
 *   · SIGTERM/SIGINT：先摘流量 → 等在途请求跑完 → 关连接池 → 退出（滚动发布不丢请求）
 *   · 退出超时强制 kill，避免僵死
 *
 * 注意：本服务**不建表**。数据库 schema 由小程序后端（miniprogram-server）拥有。
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
  /* 等 Redis 就绪（最多 2s），避免「已开始接请求但黑名单/限流还没上班」的窗口 */
  await redis.waitReady(2000);

  const dbOk = await db.health();
  if (!dbOk) {
    logger.error('数据库连接失败，请检查 DB_* 配置与 MySQL 是否启动');
    process.exit(1);
  }

  const app = build();
  const addr = await app.listen(config.port, config.host);

  logger.info('admin server started', {
    env: config.env,
    addr: config.host + ':' + addr.port,
    apiPrefix: config.apiPrefix,
    upstream: config.internal.baseUrl,
    internalEnabled: !!config.internal.token,
    redis: redis.healthy() ? 'on' : 'degraded(off)',
    dbConnLimit: config.db.connectionLimit,
    maxInflight: config.maxInflight,
  });

  if (!redis.healthy()) {
    logger.warn('Redis 不可用，已降级运行：限流与锁退化为进程内实现');
  }
  if (!config.internal.token) {
    /* 不配令牌时内部接口会全部拒绝，这里启动时就喊出来，避免上线后才发现 */
    logger.warn('INTERNAL_TOKEN 未配置：依赖小程序后端的接口（订单流转/退款/核销/发券）将不可用');
  }

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
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
      logger.error('shutdown error', { message: e && e.message });
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
    shutdown('uncaughtException');
  });

  return app;
}

main().catch((e) => {
  logger.error('bootstrap failed', {
    message: e && e.message,
    stack: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join(' | ') : '',
  });
  process.exit(1);
});
