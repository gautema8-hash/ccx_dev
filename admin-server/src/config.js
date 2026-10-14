/**
 * 配置加载（零依赖）
 * - 解析 .env（不引 dotenv，避免多一层供应链）
 * - 生产环境强校验：APP_ID / APP_SECRET / MCH_ID / 私钥 等缺一不可，缺了直接拒绝启动
 *   —— 「带病上线」比「启动失败」危险得多
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, 'utf8');
  text.split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const i = s.indexOf('=');
    if (i < 0) return;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  });
  return out;
}

const fileEnv = parseEnvFile(path.join(ROOT, '.env'));
const raw = Object.assign({}, fileEnv, process.env);

const num = (k, d) => {
  const v = Number(raw[k]);
  return Number.isFinite(v) ? v : d;
};
const str = (k, d) => (raw[k] === undefined || raw[k] === '' ? d : String(raw[k]));
const bool = (k, d) => {
  const v = raw[k];
  if (v === undefined || v === '') return d;
  return v === '1' || v === 'true' || v === 'yes';
};

const config = {
  env: str('NODE_ENV', 'development'),
  port: num('PORT', 3001),
  host: str('HOST', '0.0.0.0'),
  apiPrefix: str('API_PREFIX', '/miniapp/v1/admin'),
  maxInflight: num('MAX_INFLIGHT', 2000),
  bodyLimit: num('BODY_LIMIT', 256 * 1024),

  jwtSecret: str('JWT_SECRET', 'dev-only-change-me-9f2c1a7b4e6d8f30'),
  jwtTtl: num('JWT_TTL', 604800),
  refreshTtl: num('REFRESH_TTL', 2592000),

  db: {
    host: str('DB_HOST', '127.0.0.1'),
    port: num('DB_PORT', 3306),
    user: str('DB_USER', 'root'),
    password: str('DB_PASSWORD', ''),
    database: str('DB_NAME', 'lbz_order'),
    connectionLimit: num('DB_CONN_LIMIT', 20),
    acquireTimeout: num('DB_ACQUIRE_TIMEOUT', 8000),
    queueLimit: num('DB_QUEUE_LIMIT', 200),
  },

  redis: {
    enabled: bool('REDIS_ENABLED', true),
    host: str('REDIS_HOST', '127.0.0.1'),
    port: num('REDIS_PORT', 6379),
    password: str('REDIS_PASSWORD', ''),
    db: num('REDIS_DB', 0),
    keyPrefix: str('REDIS_KEY_PREFIX', 'lbz:'),
  },

  wx: {
    loginMode: str('LOGIN_MODE', 'mock'), // real | mock
    appid: str('APPID', ''),
    appSecret: str('APP_SECRET', ''),
  },

  pay: {
    mode: str('PAY_MODE', 'mock'), // real | mock
    mchId: str('MCH_ID', ''),
    serialNo: str('MCH_SERIAL_NO', ''),
    privateKeyPath: str('MCH_PRIVATE_KEY_PATH', ''),
    apiv3Key: str('APIV3_KEY', ''),
    notifyUrl: str('PAY_NOTIFY_URL', ''),
    timeoutMin: num('PAY_TIMEOUT_MIN', 15),
  },

  biz: {
    packFee: num('PACK_FEE', 100),
    maxOrderAmount: num('MAX_ORDER_AMOUNT', 100000),
    orderRateLimit: num('ORDER_RATE_LIMIT', 5),
    menuCacheTtl: num('MENU_CACHE_TTL', 60),
  },

  /** 商家端后台令牌（兼容旧单店模式，连锁模式下走 mp_staff 账号体系） */
  admin: {
    token: str('ADMIN_TOKEN', ''),
  },

  /** 管理端账号体系（连锁） */
  staff: {
    /** 访问令牌有效期（秒），短时效降低被窃取后的风险窗口 */
    tokenTtl: num('STAFF_TOKEN_TTL', 7200),
    /** 刷新令牌有效期（秒） */
    refreshTtl: num('STAFF_REFRESH_TTL', 604800),
  },

  /** 团购券核销 */
  voucher: {
    /** mock = 本地校验规则（无第三方凭据也能全链路跑通）；meituan = 真实调用美团开放平台 */
    provider: str('VOUCHER_PROVIDER', 'mock'),
    meituan: {
      appKey: str('MEITUAN_APP_KEY', ''),
      appSecret: str('MEITUAN_APP_SECRET', ''),
      apiBase: str('MEITUAN_API_BASE', 'https://openapi.meituan.com'),
      /** 门店与美团门店的映射靠 mp_store.code 对应 */
    },
  },

  /** 调用小程序后端内部接口（订单流转/退款/核销/发券/库存） */
  internal: {
    baseUrl: str('MINIPROGRAM_SERVER_URL', 'http://127.0.0.1:3000'),
    /** 必须与小程序后端的 INTERNAL_TOKEN 一致 */
    token: str('INTERNAL_TOKEN', ''),
    timeoutMs: num('INTERNAL_TIMEOUT_MS', 8000),
  },

  /** 连锁业务参数 */
  chain: {
    /** 附近门店最多返回多少家 */
    nearbyLimit: num('NEARBY_LIMIT', 20),
    /** 附近门店搜索半径（公里） */
    nearbyRadiusKm: num('NEARBY_RADIUS_KM', 50),
    /** 单条团购券核销的最大面值（分），超此值需二次确认，防内部作弊 */
    voucherMaxFaceValue: num('VOUCHER_MAX_FACE_VALUE', 200000),
  },
};

/** 生产环境硬校验：宁可起不来，也不要带病收钱 */
function assertProductionReady() {
  if (config.env !== 'production') return [];
  const problems = [];
  const need = (ok, msg) => {
    if (!ok) problems.push(msg);
  };
  need(config.jwtSecret && config.jwtSecret.length >= 32, 'JWT_SECRET 必须 ≥ 32 位随机串');
  need(config.jwtSecret !== 'dev-only-change-me-9f2c1a7b4e6d8f30', 'JWT_SECRET 仍是默认值');
  need(!!config.admin.token && config.admin.token.length >= 16, 'ADMIN_TOKEN 未配置或过短（商家端后台令牌）');
  if (config.wx.loginMode === 'real') {
    need(!!config.wx.appid, 'APPID 未配置');
    need(!!config.wx.appSecret, 'APP_SECRET 未配置（LOGIN_MODE=real 时必填）');
  }
  if (config.pay.mode === 'real') {
    need(!!config.pay.mchId, 'MCH_ID 未配置');
    need(!!config.pay.serialNo, 'MCH_SERIAL_NO 未配置');
    need(!!config.pay.privateKeyPath, 'MCH_PRIVATE_KEY_PATH 未配置');
    need(!!config.pay.apiv3Key && config.pay.apiv3Key.length === 32, 'APIV3_KEY 必须是 32 位');
    need(!!config.pay.notifyUrl && config.pay.notifyUrl.startsWith('https://'), 'PAY_NOTIFY_URL 必须是 HTTPS');
  }
  return problems;
}

module.exports = config;
module.exports.assertProductionReady = assertProductionReady;
