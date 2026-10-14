/**
 * redis-init.js —— Redis 初始化与维护脚本（老北京麻辣串串香 · 连锁点单系统）
 *
 * ── 为什么本项目 Redis 没有"必须初始化"的数据 ──
 * Redis 只承担：菜单/主题缓存、限流计数、分布式锁、幂等键、令牌黑名单。
 * 这些全部是**运行时动态产生**的，不依赖任何前置数据；因此"初始化"= 验证可达 + 可选清空。
 * 业务持久化数据（订单/库存/用户）在 MySQL，不落在 Redis。
 *
 * ── 用法（在 miniprogram-server 目录下）──
 *   node db/redis-init.js               # 只读：验证连接 + 统计本命名空间键
 *   node db/redis-init.js --flush       # 清空本项目的 lbz:* 键（危险，需二次确认）
 *
 * ── 键前缀约定（keyPrefix=lbz: 由 ioredis 自动加，段前缀见 src/redis.js / src/auth.js）──
 *   lbz:c:*    缓存（cache.get/set/del：菜单、主题、用户信息）
 *   lbz:r:*    限流计数（rateLimit.incr/hit：登录、下单、领券、核销）
 *   lbz:l:*    分布式锁（lock.acquire/release：下单串行化）
 *   lbz:bl:*   令牌 jti 黑名单（auth.js：登出即失效）
 *   注意：幂等键不在 Redis，在 MySQL 的 mp_idempotency 表（DB 唯一键兜底）
 */
const Redis = require('ioredis');
const readline = require('readline');

const HOST = process.env.REDIS_HOST || '127.0.0.1';
const PORT = Number(process.env.REDIS_PORT || 6379);
const PASSWORD = process.env.REDIS_PASSWORD || '';
const PREFIX = process.env.REDIS_KEY_PREFIX || 'lbz:';
const flush = process.argv.includes('--flush');

(async () => {
  const r = new Redis({ host: HOST, port: PORT, password: PASSWORD || undefined, lazyConnect: true });
  try {
    await r.connect();
    const info = await r.info('server');
    const ver = (info.match(/redis_version:(\S+)/) || [])[1];
    console.log('✅ Redis 可达  版本 ' + ver + '  @ ' + HOST + ':' + PORT);

    // 统计各命名空间的键数量（SCAN，避免 KEYS 阻塞大库）
    const buckets = {};
    let total = 0;
    let cursor = '0';
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', PREFIX + '*', 'COUNT', 500);
      cursor = next;
      for (const k of keys) {
        total++;
        const seg = k.slice(PREFIX.length).split(':')[0] || '(other)';
        buckets[seg] = (buckets[seg] || 0) + 1;
      }
    } while (cursor !== '0');

    console.log('本命名空间（' + PREFIX + '*）键总数：' + total);
    if (total) {
      console.log('分类统计：');
      Object.keys(buckets)
        .sort()
        .forEach((b) => console.log('  ' + PREFIX + b + ':*  ' + buckets[b]));
    }

    if (flush) {
      console.log('\n⚠️  即将清空本项目的全部 ' + total + ' 个键（' + PREFIX + '*）。');
      console.log('    这会：使菜单/主题缓存失效（下次自动重建）、清空限流计数与登录黑名单。');
      console.log('    **不影响** MySQL 里的任何业务数据。');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise((res) => rl.question('输入 YES 确认清空：', res));
      rl.close();
      if (answer !== 'YES') {
        console.log('已取消。');
        r.disconnect();
        return;
      }
      let removed = 0;
      cursor = '0';
      do {
        const [next, keys] = await r.scan(cursor, 'MATCH', PREFIX + '*', 'COUNT', 500);
        cursor = next;
        if (keys.length) {
          await r.del(...keys);
          removed += keys.length;
        }
      } while (cursor !== '0');
      console.log('✅ 已清空 ' + removed + ' 个键。');
    }
  } catch (e) {
    console.error('❌ Redis 连接失败：' + (e && e.message));
    process.exitCode = 1;
  } finally {
    r.disconnect();
  }
})();
