/**
 * 数据访问（管理系统后端）
 *
 * ── 与小程序后端的边界 ──
 * 数据库 schema 由 **小程序后端（miniprogram-server）** 拥有：`migrate` / `seed` / 加列
 * 都在那边。本服务只做读写，**不建表、不改表**，避免两边 schema 定义分歧。
 *
 * 同理：订单状态机、券抵扣口径、团购券核销防重这些"领域规则"也只有一份（在小程序后端），
 * 本服务通过 internalApi 调用，不复制实现。
 */
const mysql = require('mysql2/promise');
const config = require('./config');
const logger = require('./logger');

let pool = null;

function init() {
  if (pool) return pool;
  pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: config.db.connectionLimit,
    queueLimit: config.db.queueLimit,
    acquireTimeout: config.db.acquireTimeout,
    charset: 'utf8mb4',
    timezone: '+08:00',
  });
  pool.on('error', (e) => {
    /* 连接池级错误必须记日志，否则连接泄漏时完全无感 */
    logger.error('db pool error', { message: e && e.message });
  });
  return pool;
}

async function query(sql, params) {
  if (!pool) init();
  const [rows] = await pool.execute(sql, params || []);
  return rows;
}
async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows && rows.length ? rows[0] : null;
}
async function execute(sql, params) {
  if (!pool) init();
  const [r] = await pool.execute(sql, params || []);
  return r;
}

/**
 * 事务：回调内用 tx.query / tx.execute，失败整体回滚。
 * 注意：事务期间必须全程使用 tx，混用外部 query 会拿到另一条连接，锁不住行。
 */
async function tx(fn) {
  if (!pool) init();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const api = {
      query: async (sql, params) => {
        const [rows] = await conn.execute(sql, params || []);
        return rows;
      },
      queryOne: async (sql, params) => {
        const [rows] = await conn.execute(sql, params || []);
        return rows && rows.length ? rows[0] : null;
      },
      execute: async (sql, params) => {
        const [r] = await conn.execute(sql, params || []);
        return r;
      },
    };
    const out = await fn(api);
    await conn.commit();
    return out;
  } catch (e) {
    try {
      await conn.rollback();
    } catch (e2) {
      logger.warn('rollback failed', { message: e2 && e2.message });
    }
    throw e;
  } finally {
    conn.release();
  }
}

async function health() {
  try {
    if (!pool) init();
    await pool.query('SELECT 1');
    return true;
  } catch (e) {
    logger.warn('db health check failed', { message: e && e.message });
    return false;
  }
}

async function close() {
  if (!pool) return;
  try {
    await pool.end();
  } catch (e) {
    logger.warn('db close failed', { message: e && e.message });
  }
  pool = null;
}

module.exports = { init, query, queryOne, execute, tx, health, close, get pool() { return pool; } };
