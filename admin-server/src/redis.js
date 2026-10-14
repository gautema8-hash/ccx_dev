/**
 * Redis 客户端（可选依赖，必须能「优雅降级」）
 *
 * 交付级要点：
 *   · enableOfflineQueue=false + maxRetriesPerRequest=1 —— Redis 挂掉时命令**快速失败**，
 *     绝不把请求堆在本地队列里把内存撑爆
 *   · 每次操作前检查 status，未就绪直接走降级分支（不抛错、不阻塞主流程）
 *   · 缓存/限流/锁三个用途分别封装；锁用 Lua 保证「只删自己的锁」
 *   · Redis 完全不可用时：缓存侧穿透到 DB，限流侧退化为进程内计数，锁侧退化为进程内 Mutex
 */
const Redis = require('ioredis');
const config = require('./config');
const logger = require('./logger');

const P = config.redis.keyPrefix;

let client = null;
let ready = false;
let lastError = '';

function init() {
  if (!config.redis.enabled) {
    logger.warn('redis disabled by config, running in degraded mode');
    return null;
  }
  client = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    db: config.redis.db,
    keyPrefix: P,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    commandTimeout: 2000,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });

  client.on('ready', () => {
    ready = true;
    logger.info('redis ready', { host: config.redis.host, port: config.redis.port });
  });
  client.on('error', (e) => {
    ready = false;
    if (lastError !== e.message) {
      lastError = e.message;
      logger.warn('redis error (degraded)', { message: e.message });
    }
  });
  client.on('close', () => {
    ready = false;
  });
  client.on('reconnecting', () => {
    ready = false;
  });

  client.connect().catch((e) => {
    ready = false;
    logger.warn('redis connect failed (degraded)', { message: e.message });
  });
  return client;
}

function healthy() {
  return !!(client && ready && client.status === 'ready');
}

async function safe(fn, fallback) {
  if (!healthy()) return fallback;
  try {
    return await fn();
  } catch (e) {
    logger.warn('redis op failed, fallback', { message: e.message });
    return fallback;
  }
}

/* ------------------------------ 缓存 ------------------------------ */
const cache = {
  async get(key) {
    const v = await safe(() => client.get('c:' + key), null);
    if (v == null) return null;
    try {
      return JSON.parse(v);
    } catch (e) {
      return null;
    }
  },
  async set(key, value, ttlSec) {
    const s = JSON.stringify(value);
    return safe(() => client.set('c:' + key, s, 'EX', Math.max(1, ttlSec || 60)), 'OK');
  },
  async del(key) {
    return safe(() => client.del('c:' + key), 0);
  },
  /** 按前缀失效（菜单变更时用） */
  async delByPrefix(prefix) {
    return safe(async () => {
      const keys = await client.keys('c:' + prefix + '*');
      if (!keys.length) return 0;
      return client.del(keys);
    }, 0);
  },
};

/* ------------------------------ 分布式锁 ------------------------------ */
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

const localLocks = new Map();

const lock = {
  /**
   * 尝试获取锁；返回 token（成功）或 null（失败）
   * Redis 不可用时退化为进程内锁（单实例部署下同样能挡住重复提交）
   */
  async acquire(key, ttlMs, token) {
    const k = 'l:' + key;
    const t = token || Math.random().toString(36).slice(2) + Date.now().toString(36);
    if (healthy()) {
      const r = await safe(() => client.set(k, t, 'PX', ttlMs, 'NX'), null);
      return r === 'OK' ? t : null;
    }
    const now = Date.now();
    const cur = localLocks.get(k);
    if (cur && cur.expireAt > now) return null;
    localLocks.set(k, { token: t, expireAt: now + ttlMs });
    return t;
  },
  async release(key, token) {
    const k = 'l:' + key;
    if (healthy()) {
      await safe(() => client.eval(RELEASE_LUA, 1, k, token), 0);
      return;
    }
    const cur = localLocks.get(k);
    if (cur && cur.token === token) localLocks.delete(k);
  },
};

/* ------------------------------ 限流（滑动窗口计数） ------------------------------ */
const localCounters = new Map();

const rateLimit = {
  /**
   * 只读检查（不计数）：用于「先判断是否超限」，配合 incr 实现
   * 「只统计成功操作」的限流语义 —— 用户填错表单不该被锁。
   */
  async peek(key, limit, windowSec) {
    const k = 'r:' + key;
    if (healthy()) {
      const r = await safe(async () => {
        const v = await client.get(k);
        const ttl = await client.ttl(k);
        return { n: Number(v || 0), ttl: ttl < 0 ? windowSec : ttl };
      }, null);
      if (r) return { allowed: r.n < limit, count: r.n, resetSec: r.ttl };
    }
    const now = Date.now();
    const c = localCounters.get(k);
    if (!c || c.resetAt <= now) return { allowed: true, count: 0, resetSec: windowSec };
    return { allowed: c.n < limit, count: c.n, resetSec: Math.ceil((c.resetAt - now) / 1000) };
  },

  /** 计数 +1（在操作成功后调用） */
  async incr(key, windowSec) {
    const k = 'r:' + key;
    if (healthy()) {
      await safe(async () => {
        const n = await client.incr(k);
        if (n === 1) await client.expire(k, windowSec);
        return n;
      }, 0);
      return;
    }
    const now = Date.now();
    let c = localCounters.get(k);
    if (!c || c.resetAt <= now) c = { n: 0, resetAt: now + windowSec * 1000 };
    c.n++;
    localCounters.set(k, c);
  },

  /**
   * 检查并立即计数（用于「每次调用都应计数」的场景，如登录、催单）
   * @returns {{allowed:boolean, remaining:number, resetSec:number}}
   */
  async hit(key, limit, windowSec) {
    const k = 'r:' + key;
    if (healthy()) {
      const r = await safe(async () => {
        const n = await client.incr(k);
        if (n === 1) await client.expire(k, windowSec);
        const ttl = await client.ttl(k);
        return { n, ttl: ttl < 0 ? windowSec : ttl };
      }, null);
      if (r) {
        return { allowed: r.n <= limit, remaining: Math.max(0, limit - r.n), resetSec: r.ttl };
      }
    }
    // 降级：进程内固定窗口
    const now = Date.now();
    let c = localCounters.get(k);
    if (!c || c.resetAt <= now) c = { n: 0, resetAt: now + windowSec * 1000 };
    c.n++;
    localCounters.set(k, c);
    // 顺手清理，防止 map 无限增长
    if (localCounters.size > 5000) {
      for (const [kk, vv] of localCounters) {
        if (vv.resetAt <= now) localCounters.delete(kk);
      }
    }
    return { allowed: c.n <= limit, remaining: Math.max(0, limit - c.n), resetSec: Math.ceil((c.resetAt - now) / 1000) };
  },
};

/** 等待就绪（启动时用，避免「服务已监听但缓存还没连上」的窗口） */
function waitReady(timeoutMs) {
  if (healthy()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const deadline = Date.now() + (timeoutMs || 2000);
    const tick = () => {
      if (healthy()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * 清空本应用命名空间下的所有键（db reset 时用，避免限流/锁/缓存与重置后的数据错位）
 *
 * 注意：必须用一个「不带 keyPrefix」的客户端来做 SCAN + DEL。
 * 带 keyPrefix 的客户端 SCAN 返回的是完整键名，DEL 时会被再加一次前缀 → 一个都删不掉
 * （这就是之前 reset 后限流计数仍累加的原因）。
 */
let plainClient = null;
async function getPlainClient() {
  if (plainClient && plainClient.status === 'ready') return plainClient;
  plainClient = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    db: config.redis.db,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    commandTimeout: 3000,
    retryStrategy: () => null,
  });
  plainClient.on('error', () => {});
  await plainClient.connect().catch(() => {});
  return plainClient;
}

async function flushAppKeys() {
  try {
    const c = await getPlainClient();
    if (c.status !== 'ready') return 0;
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await c.scan(cursor, 'MATCH', P + '*', 'COUNT', 500);
      cursor = next;
      if (keys.length) deleted += await c.del(keys);
    } while (cursor !== '0');
    return deleted;
  } catch (e) {
    logger.warn('flushAppKeys failed', { message: e.message });
    return 0;
  }
}

async function quit() {
  if (plainClient) {
    try {
      plainClient.disconnect();
    } catch (e) {}
    plainClient = null;
  }
  if (client) {
    try {
      await client.quit();
    } catch (e) {
      try {
        client.disconnect();
      } catch (e2) {}
    }
  }
}

module.exports = {
  init,
  healthy,
  waitReady,
  cache,
  lock,
  rateLimit,
  flushAppKeys,
  quit,
  get client() {
    return client;
  },
};
