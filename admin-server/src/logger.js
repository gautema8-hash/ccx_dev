/**
 * 结构化日志（JSON lines）
 * - 每条日志带 requestId，方便串联一次请求的全过程
 * - 慢请求 / 5xx 自动升级为 warn / error
 * - 不打印敏感字段（token、手机号、openid 全量）
 */
const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const threshold = LEVELS[config.env === 'production' ? 'info' : 'debug'];

/** 直接置为 *** 的字段 */
const SENSITIVE = [
  'token', 'access_token', 'refresh_token', 'authorization', 'password', 'session_key',
  'secret', 'appsecret', 'apiv3key', 'privatekey', 'appscret', 'mchkey',
];
/** 部分脱敏：保留前后各若干位，便于排障又不泄露完整值 */
const MASK_RULES = [
  { re: /openid/i, head: 6, tail: 0 },
  { re: /(phone|mobile|tel)/i, head: 3, tail: 4 },
  { re: /(idcard|idno)/i, head: 6, tail: 4 },
];

function mask(v, head, tail) {
  const s = String(v);
  if (s.length <= head + tail) return '***';
  return s.slice(0, head) + '***' + (tail ? s.slice(-tail) : '');
}

function scrub(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 4) return obj;
  if (Array.isArray(obj)) return obj.slice(0, 20).map((x) => scrub(x, depth + 1));
  const out = {};
  Object.keys(obj).forEach((k) => {
    const v = obj[k];
    const lk = k.toLowerCase();
    if (SENSITIVE.indexOf(lk) > -1) {
      out[k] = '***';
      return;
    }
    const rule = MASK_RULES.find((r) => r.re.test(lk));
    if (rule && typeof v === 'string') {
      out[k] = mask(v, rule.head, rule.tail);
      return;
    }
    /* 券码 / 微信登录 code：长度够长的一律只留前 4 位 */
    if ((lk === 'code' || lk === 'couponcode') && typeof v === 'string' && v.length >= 8) {
      out[k] = v.slice(0, 4) + '***';
      return;
    }
    out[k] = scrub(v, depth + 1);
  });
  return out;
}

function write(level, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const line = {
    t: new Date().toISOString(),
    lv: level,
    msg,
    pid: process.pid,
    ...(extra ? scrub(extra, 0) : {}),
  };
  const s = JSON.stringify(line);
  if (level === 'error') process.stderr.write(s + '\n');
  else process.stdout.write(s + '\n');
}

module.exports = {
  debug: (msg, extra) => write('debug', msg, extra),
  info: (msg, extra) => write('info', msg, extra),
  warn: (msg, extra) => write('warn', msg, extra),
  error: (msg, extra) => write('error', msg, extra),
  scrub,
};
