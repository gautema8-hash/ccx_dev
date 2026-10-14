/**
 * 数据访问层
 *   · connection pool + 事务封装（死锁/锁等待自动重试）
 *   · migrate：幂等建表（可重复执行）
 *   · seed：菜单数据**直接复用小程序里的 mock/menu.js**，保证前后端菜单单一事实来源
 *   · health：给健康检查与就绪探针用
 */
const mysql = require('mysql2/promise');
const path = require('path');
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
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    /** 分→元 之类的浮点运算一律在应用层做，DB 只存整数分 */
    decimalNumbers: true,
    multipleStatements: false,
    charset: 'utf8mb4_general_ci',
    timezone: '+08:00',
  });
  pool.on('connection', (c) => {
    c.query("SET SESSION sql_mode='STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'");
  });
  return pool;
}

async function query(sql, params) {
  const [rows] = await init().query(sql, params || []);
  return rows;
}
async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows && rows.length ? rows[0] : null;
}
async function execute(sql, params) {
  const [r] = await init().execute(sql, params || []);
  return r; // { affectedRows, insertId, changedRows }
}

const RETRYABLE = new Set([1213, 1205]); // Deadlock / Lock wait timeout

/**
 * 事务：回调内所有操作同一个连接，异常自动回滚
 * 死锁/锁等待超时自动重试（最多 2 次），高并发下这是必需的
 */
async function tx(fn, opts) {
  const maxTry = (opts && opts.retry) || 3;
  let attempt = 0;
  for (;;) {
    attempt++;
    const conn = await init().getConnection();
    try {
      await conn.beginTransaction();
      const api = {
        query: async (sql, params) => (await conn.query(sql, params || []))[0],
        queryOne: async (sql, params) => {
          const [rows] = await conn.query(sql, params || []);
          return rows && rows.length ? rows[0] : null;
        },
        execute: async (sql, params) => (await conn.execute(sql, params || []))[0],
      };
      const result = await fn(api);
      await conn.commit();
      return result;
    } catch (e) {
      try {
        await conn.rollback();
      } catch (e2) {}
      if (RETRYABLE.has(e.errno) && attempt < maxTry) {
        logger.warn('tx retry', { errno: e.errno, attempt });
        await new Promise((r) => setTimeout(r, 20 * attempt));
        continue;
      }
      throw e;
    } finally {
      conn.release();
    }
  }
}

/**
 * 原子自增序列（订单号、取餐号）
 *
 * 为什么必须是「事务 + 行锁」：
 *   常见写法 `UPDATE mp_seq SET val = LAST_INSERT_ID(val+1)` 依赖 LAST_INSERT_ID() 与 UPDATE
 *   在**同一连接**上，而连接池里下一次查询大概率换连接 → 读到 0 或别的值；
 *   即使改成 UPDATE 后再 SELECT，两个并发事务也会读到同一个 val，产生重复序列。
 *   实测就是这里导致并发下单订单号撞号、大量 500。
 *   这里用 SELECT ... FOR UPDATE 把同一 name 的取号串行化，彻底消除竞态。
 */
async function nextSeq(name, modulo) {
  return tx(async (t) => {
    await t.execute('INSERT INTO mp_seq (name, val) VALUES (?, 0) ON DUPLICATE KEY UPDATE name = name', [name]);
    const row = await t.queryOne('SELECT val FROM mp_seq WHERE name = ? FOR UPDATE', [name]);
    const next = Number(row.val) + 1;
    await t.execute('UPDATE mp_seq SET val = ? WHERE name = ?', [next, name]);
    return modulo ? ((next - 1) % modulo) + 1 : next;
  });
}

async function health() {
  try {
    await query('SELECT 1 AS ok');
    return true;
  } catch (e) {
    logger.warn('db health check failed', { message: e.message });
    return false;
  }
}

async function close() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
}

/* ============================================================ DDL */
const DDL = [
  /* ============================ 组织：品牌 / 门店 ============================ */
  `CREATE TABLE IF NOT EXISTS mp_brand (
    id            VARCHAR(32)  NOT NULL PRIMARY KEY,
    name          VARCHAR(128) NOT NULL,
    logo          VARCHAR(32)  NOT NULL DEFAULT '🌶️',
    notice        VARCHAR(255) NOT NULL DEFAULT '',
    contact       VARCHAR(64)  NOT NULL DEFAULT '',
    status        TINYINT      NOT NULL DEFAULT 1,
    created_at    BIGINT       NOT NULL,
    updated_at    BIGINT       NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /**
   * 门店（取代原 mp_shop）
   * type: DIRECT=直营 / FRANCHISE=加盟 —— 这是权限与数据隔离的第一维度
   */
  `CREATE TABLE IF NOT EXISTS mp_store (
    id             VARCHAR(32)  NOT NULL PRIMARY KEY,
    brand_id       VARCHAR(32)  NOT NULL,
    code           VARCHAR(32)  NOT NULL DEFAULT '',
    name           VARCHAR(128) NOT NULL,
    type           VARCHAR(16)  NOT NULL DEFAULT 'DIRECT' COMMENT 'DIRECT直营|FRANCHISE加盟',
    franchisee     VARCHAR(128) NOT NULL DEFAULT '' COMMENT '加盟商主体名称',
    region         VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '大区，区域经理按此授权',
    city           VARCHAR(64)  NOT NULL DEFAULT '',
    address        VARCHAR(255) NOT NULL DEFAULT '',
    phone          VARCHAR(32)  NOT NULL DEFAULT '',
    latitude       DECIMAL(10,6) NOT NULL DEFAULT 0,
    longitude      DECIMAL(10,6) NOT NULL DEFAULT 0,
    open_time      VARCHAR(64)  NOT NULL DEFAULT '',
    per_capita     INT          NOT NULL DEFAULT 0,
    tables_json    VARCHAR(512) NOT NULL DEFAULT '[]' COMMENT '堂食桌号',
    status         TINYINT      NOT NULL DEFAULT 1 COMMENT '0停业 1营业',
    created_at     BIGINT       NOT NULL,
    updated_at     BIGINT       NOT NULL,
    UNIQUE KEY uk_code (brand_id, code),
    KEY idx_brand (brand_id, status),
    KEY idx_type (type, status),
    KEY idx_region (region),
    KEY idx_geo (latitude, longitude)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /* ============================ 员工账号 / 权限 ============================ */
  /**
   * 管理端账号
   * role: BRAND_ADMIN 品牌超管 / REGION_MANAGER 区域经理 / STORE_MANAGER 店长 /
   *       STAFF 店员 / FRANCHISE_OWNER 加盟商
   */
  `CREATE TABLE IF NOT EXISTS mp_staff (
    id             BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    brand_id       VARCHAR(32)  NOT NULL,
    account        VARCHAR(64)  NOT NULL,
    password_hash  VARCHAR(128) NOT NULL,
    password_salt  VARCHAR(64)  NOT NULL,
    name           VARCHAR(64)  NOT NULL DEFAULT '',
    phone          VARCHAR(32)  NOT NULL DEFAULT '',
    role           VARCHAR(32)  NOT NULL,
    region         VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '区域经理授权的大区',
    all_stores     TINYINT      NOT NULL DEFAULT 0 COMMENT '1=品牌超管，可见全部门店',
    must_change_pwd TINYINT     NOT NULL DEFAULT 0,
    status         TINYINT      NOT NULL DEFAULT 1 COMMENT '0停用 1启用',
    last_login_at  BIGINT       NOT NULL DEFAULT 0,
    fail_count     INT          NOT NULL DEFAULT 0,
    locked_until   BIGINT       NOT NULL DEFAULT 0,
    created_at     BIGINT       NOT NULL,
    updated_at     BIGINT       NOT NULL,
    UNIQUE KEY uk_account (brand_id, account),
    KEY idx_role (brand_id, role)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /** 员工可见门店（数据隔离的落地依据：所有业务查询都会注入这里的结果） */
  `CREATE TABLE IF NOT EXISTS mp_staff_store (
    id       BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
    staff_id BIGINT      NOT NULL,
    store_id VARCHAR(32) NOT NULL,
    UNIQUE KEY uk_staff_store (staff_id, store_id),
    KEY idx_store (store_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /** 审计日志：管理端所有写操作都要留痕 */
  `CREATE TABLE IF NOT EXISTS mp_audit_log (
    id         BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    brand_id   VARCHAR(32)  NOT NULL DEFAULT '',
    store_id   VARCHAR(32)  NOT NULL DEFAULT '',
    staff_id   BIGINT       NOT NULL DEFAULT 0,
    staff_name VARCHAR(64)  NOT NULL DEFAULT '',
    role       VARCHAR(32)  NOT NULL DEFAULT '',
    action     VARCHAR(64)  NOT NULL,
    target     VARCHAR(64)  NOT NULL DEFAULT '',
    detail     VARCHAR(1024) NOT NULL DEFAULT '',
    ip         VARCHAR(64)  NOT NULL DEFAULT '',
    ua         VARCHAR(255) NOT NULL DEFAULT '',
    request_id VARCHAR(64)  NOT NULL DEFAULT '',
    created_at BIGINT       NOT NULL,
    KEY idx_brand_time (brand_id, created_at),
    KEY idx_staff (staff_id, created_at),
    KEY idx_action (action, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /** 登录日志（含失败），用于风控与暴力破解排查 */
  `CREATE TABLE IF NOT EXISTS mp_login_log (
    id         BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    brand_id   VARCHAR(32)  NOT NULL DEFAULT '',
    account    VARCHAR(64)  NOT NULL DEFAULT '',
    staff_id   BIGINT       NOT NULL DEFAULT 0,
    ip         VARCHAR(64)  NOT NULL DEFAULT '',
    ua         VARCHAR(255) NOT NULL DEFAULT '',
    success    TINYINT      NOT NULL DEFAULT 0,
    reason     VARCHAR(64)  NOT NULL DEFAULT '',
    created_at BIGINT       NOT NULL,
    KEY idx_account_time (account, created_at),
    KEY idx_ip_time (ip, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /* ============================ 主题（品牌活动日 / 节假日 / 会员日） ============================ */
  /**
   * 主题优先级解析：门店级(store_id 非空) > 品牌级(store_id='')，
   * 同一层级取「在生效时间窗内 + priority 最大」的那一条
   * tokens 是设计令牌的覆盖集合（主色、辅色、按钮圆角、Banner 文案等）
   */
  `CREATE TABLE IF NOT EXISTS mp_theme (
    id          VARCHAR(32)  NOT NULL PRIMARY KEY,
    brand_id    VARCHAR(32)  NOT NULL,
    store_id    VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '空=品牌级主题',
    name        VARCHAR(64)  NOT NULL,
    type        VARCHAR(24)  NOT NULL DEFAULT 'CUSTOM' COMMENT 'NORMAL|CAMPAIGN|HOLIDAY|MEMBER_DAY|CUSTOM',
    tokens_json TEXT         NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    start_at    BIGINT       NOT NULL DEFAULT 0,
    end_at      BIGINT       NOT NULL DEFAULT 0,
    priority    INT          NOT NULL DEFAULT 0,
    status      TINYINT      NOT NULL DEFAULT 1 COMMENT '0停用 1启用',
    created_by  BIGINT       NOT NULL DEFAULT 0,
    created_at  BIGINT       NOT NULL,
    updated_at  BIGINT       NOT NULL,
    KEY idx_brand (brand_id, status, priority),
    KEY idx_store (store_id, status, priority),
    KEY idx_window (start_at, end_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /* ============================ 菜品：品牌模板 + 门店覆盖 ============================ */
  `CREATE TABLE IF NOT EXISTS mp_category (
    id         VARCHAR(32)  NOT NULL PRIMARY KEY,
    brand_id   VARCHAR(32)  NOT NULL,
    name       VARCHAR(64)  NOT NULL,
    emoji      VARCHAR(8)   NOT NULL DEFAULT '',
    sort       INT          NOT NULL DEFAULT 0,
    status     TINYINT      NOT NULL DEFAULT 1,
    KEY idx_brand_sort (brand_id, status, sort)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /** 菜品模板属于品牌（总部统一维护菜单与指导价） */
  `CREATE TABLE IF NOT EXISTS mp_dish (
    id          VARCHAR(32)  NOT NULL PRIMARY KEY,
    brand_id    VARCHAR(32)  NOT NULL,
    category_id VARCHAR(32)  NOT NULL,
    name        VARCHAR(128) NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    emoji       VARCHAR(8)   NOT NULL DEFAULT '',
    image       VARCHAR(255) NOT NULL DEFAULT '',
    price       INT          NOT NULL COMMENT '指导价，单位：分',
    unit        VARCHAR(16)  NOT NULL DEFAULT '份',
    spicy       TINYINT      NOT NULL DEFAULT 0,
    tags        VARCHAR(255) NOT NULL DEFAULT '[]',
    status      TINYINT      NOT NULL DEFAULT 1 COMMENT '总部上下架',
    sort        INT          NOT NULL DEFAULT 0,
    updated_at  BIGINT       NOT NULL DEFAULT 0,
    KEY idx_cat (category_id, status, sort),
    KEY idx_brand (brand_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /**
   * 门店菜品（库存与门店级上下架/改价的落点）
   * —— 这是连锁模型的关键：总部管「卖什么、卖多少钱」，门店管「还有多少、今天卖不卖」
   * 库存扣减就发生在这张表上，靠原子 UPDATE 防超卖
   */
  `CREATE TABLE IF NOT EXISTS mp_store_dish (
    id             BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
    store_id       VARCHAR(32) NOT NULL,
    dish_id        VARCHAR(32) NOT NULL,
    price_override INT         NOT NULL DEFAULT 0 COMMENT '0=用总部指导价',
    stock          INT         NOT NULL DEFAULT 0,
    sold           INT         NOT NULL DEFAULT 0,
    status         TINYINT     NOT NULL DEFAULT 1 COMMENT '0本店停售 1在售',
    updated_at     BIGINT      NOT NULL DEFAULT 0,
    UNIQUE KEY uk_store_dish (store_id, dish_id),
    KEY idx_dish (dish_id),
    KEY idx_store (store_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mp_soup (
    id      VARCHAR(32)  NOT NULL PRIMARY KEY,
    brand_id VARCHAR(32) NOT NULL,
    name    VARCHAR(64)  NOT NULL,
    price   INT          NOT NULL DEFAULT 0,
    emoji   VARCHAR(8)   NOT NULL DEFAULT '',
    description VARCHAR(255) NOT NULL DEFAULT '',
    recommended TINYINT  NOT NULL DEFAULT 0,
    sort    INT          NOT NULL DEFAULT 0,
    status  TINYINT      NOT NULL DEFAULT 1,
    KEY idx_brand (brand_id, status, sort)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mp_dip (
    id      VARCHAR(32) NOT NULL PRIMARY KEY,
    brand_id VARCHAR(32) NOT NULL,
    name    VARCHAR(64) NOT NULL,
    price   INT         NOT NULL DEFAULT 0,
    emoji   VARCHAR(8)  NOT NULL DEFAULT '',
    sort    INT         NOT NULL DEFAULT 0,
    status  TINYINT     NOT NULL DEFAULT 1,
    KEY idx_brand (brand_id, status, sort)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mp_spicy (
    id    VARCHAR(32) NOT NULL PRIMARY KEY,
    name  VARCHAR(32) NOT NULL,
    color VARCHAR(16) NOT NULL DEFAULT '#8A8A8E',
    sort  INT         NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /* ============================ 优惠券（品牌/门店两级） ============================ */
  `CREATE TABLE IF NOT EXISTS mp_coupon (
    id         VARCHAR(32)  NOT NULL PRIMARY KEY,
    brand_id   VARCHAR(32)  NOT NULL DEFAULT 'brand_lbz',
    name       VARCHAR(64)  NOT NULL,
    type       VARCHAR(16)  NOT NULL COMMENT 'CASH 现金券|SOUP 锅底券|DISCOUNT 折扣券',
    value      INT          NOT NULL COMMENT '现金券=分；折扣券=折扣百分比(如 88 表示 8.8 折)',
    threshold  INT          NOT NULL DEFAULT 0 COMMENT '门槛（分），0=无门槛',
    scope      VARCHAR(128) NOT NULL DEFAULT '',
    store_ids  VARCHAR(512) NOT NULL DEFAULT '' COMMENT '空=全品牌通用；否则为 JSON 门店数组',
    issue_type VARCHAR(16)  NOT NULL DEFAULT 'MANUAL' COMMENT 'NEW_USER|CAMPAIGN|MANUAL|RECEIVE',
    receive_enabled TINYINT NOT NULL DEFAULT 0 COMMENT '1=出现在小程序领券中心',
    receive_start BIGINT    NOT NULL DEFAULT 0,
    receive_end   BIGINT    NOT NULL DEFAULT 0,
    day_limit  INT          NOT NULL DEFAULT 0 COMMENT '每人每日限领，0=不限',
    total      INT          NOT NULL DEFAULT 999999,
    issued     INT          NOT NULL DEFAULT 0,
    per_user   INT          NOT NULL DEFAULT 1,
    used_count INT          NOT NULL DEFAULT 0,
    expire_at  VARCHAR(16)  NOT NULL DEFAULT '',
    status     TINYINT      NOT NULL DEFAULT 1,
    created_by BIGINT       NOT NULL DEFAULT 0,
    created_at BIGINT       NOT NULL DEFAULT 0,
    updated_at BIGINT       NOT NULL DEFAULT 0,
    KEY idx_status (status),
    KEY idx_brand (brand_id, status),
    KEY idx_receive (receive_enabled, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /** 领券/发券记录（统计与风控用；是否持有以 mp_user_coupon 为准） */
  `CREATE TABLE IF NOT EXISTS mp_coupon_receive (
    id         BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT      NOT NULL,
    coupon_id  VARCHAR(32) NOT NULL,
    store_id   VARCHAR(32) NOT NULL DEFAULT '',
    source     VARCHAR(16) NOT NULL DEFAULT 'RECEIVE' COMMENT 'RECEIVE|NEW_USER|MANUAL|CAMPAIGN',
    operator   BIGINT      NOT NULL DEFAULT 0,
    created_at BIGINT      NOT NULL,
    KEY idx_user (user_id, created_at),
    KEY idx_coupon (coupon_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /* ============================ 美团团购券核销 ============================ */
  /**
   * 团购券核销记录
   * uk(platform, code) 是防重复核销的最后一道保险：
   * 并发核销同一张券时，只有一条能插入成功，另一条直接命中唯一键
   */
  `CREATE TABLE IF NOT EXISTS mp_voucher (
    id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    platform     VARCHAR(16)  NOT NULL DEFAULT 'MEITUAN' COMMENT 'MEITUAN|DOUYIN|MANUAL',
    code         VARCHAR(64)  NOT NULL COMMENT '券码',
    brand_id     VARCHAR(32)  NOT NULL DEFAULT '',
    store_id     VARCHAR(32)  NOT NULL,
    deal_id      VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '团购套餐 id',
    product_name VARCHAR(128) NOT NULL DEFAULT '',
    face_value   INT          NOT NULL DEFAULT 0 COMMENT '面值（分）',
    quantity     INT          NOT NULL DEFAULT 1,
    status       VARCHAR(16)  NOT NULL DEFAULT 'VERIFIED' COMMENT 'VERIFIED|REFUNDED|FAILED',
    verified_by  BIGINT       NOT NULL DEFAULT 0 COMMENT '核销人（员工 id，0=用户自助）',
    verified_at  BIGINT       NOT NULL DEFAULT 0,
    user_id      BIGINT       NOT NULL DEFAULT 0 COMMENT '自助核销的用户',
    order_id     VARCHAR(40)  NOT NULL DEFAULT '' COMMENT '联动生成的订单',
    channel      VARCHAR(16)  NOT NULL DEFAULT 'STAFF' COMMENT 'STAFF店员核销|SELF用户自助',
    raw          TEXT         NULL,
    created_at   BIGINT       NOT NULL,
    UNIQUE KEY uk_platform_code (platform, code),
    KEY idx_store_time (store_id, created_at),
    KEY idx_time (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mp_user (
    id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    openid       VARCHAR(64)  NOT NULL,
    unionid      VARCHAR(64)  NOT NULL DEFAULT '',
    nickname     VARCHAR(64)  NOT NULL DEFAULT '串串香食客',
    avatar       VARCHAR(512) NOT NULL DEFAULT '',
    phone        VARCHAR(32)  NOT NULL DEFAULT '',
    member_level INT          NOT NULL DEFAULT 1,
    member_name  VARCHAR(32)  NOT NULL DEFAULT '铜签会员',
    points       INT          NOT NULL DEFAULT 0,
    status       TINYINT      NOT NULL DEFAULT 1,
    created_at   BIGINT       NOT NULL,
    updated_at   BIGINT       NOT NULL,
    last_login_at BIGINT      NOT NULL DEFAULT 0,
    UNIQUE KEY uk_openid (openid)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mp_user_coupon (
    id        BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id   BIGINT      NOT NULL,
    coupon_id VARCHAR(32) NOT NULL,
    status    VARCHAR(16) NOT NULL DEFAULT 'UNUSED' COMMENT 'UNUSED|USED|EXPIRED',
    order_id  VARCHAR(40) NOT NULL DEFAULT '',
    got_at    BIGINT      NOT NULL,
    used_at   BIGINT      NOT NULL DEFAULT 0,
    UNIQUE KEY uk_user_coupon (user_id, coupon_id, id),
    KEY idx_user_status (user_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mp_order (
    id            VARCHAR(40)  NOT NULL PRIMARY KEY,
    order_no      VARCHAR(40)  NOT NULL,
    user_id       BIGINT       NOT NULL,
    brand_id      VARCHAR(32)  NOT NULL DEFAULT '',
    store_id      VARCHAR(32)  NOT NULL,
    store_type    VARCHAR(16)  NOT NULL DEFAULT 'DIRECT' COMMENT '下单时门店类型快照，便于分账统计',
    status        VARCHAR(16)  NOT NULL,
    dining_type   VARCHAR(16)  NOT NULL DEFAULT 'dinein',
    table_no      VARCHAR(16)  NOT NULL DEFAULT '',
    people_count  INT          NOT NULL DEFAULT 1,
    remark        VARCHAR(255) NOT NULL DEFAULT '',
    soup_id       VARCHAR(32)  NOT NULL DEFAULT '',
    soup_name     VARCHAR(64)  NOT NULL DEFAULT '',
    soup_price    INT          NOT NULL DEFAULT 0,
    dip_ids       VARCHAR(255) NOT NULL DEFAULT '[]',
    dip_names     VARCHAR(255) NOT NULL DEFAULT '',
    item_count    INT          NOT NULL DEFAULT 0,
    goods_amount  INT          NOT NULL DEFAULT 0,
    soup_fee      INT          NOT NULL DEFAULT 0,
    pack_fee      INT          NOT NULL DEFAULT 0,
    discount      INT          NOT NULL DEFAULT 0,
    pay_amount    INT          NOT NULL DEFAULT 0,
    coupon_id     VARCHAR(32)  NOT NULL DEFAULT '',
    pickup_no     VARCHAR(16)  NOT NULL DEFAULT '',
    parent_order_id VARCHAR(40) NOT NULL DEFAULT '' COMMENT '加菜场景的上游订单',
    pay_txn_id    VARCHAR(64)  NOT NULL DEFAULT '',
    pay_time      BIGINT       NOT NULL DEFAULT 0,
    finish_time   BIGINT       NOT NULL DEFAULT 0,
    cancel_time   BIGINT       NOT NULL DEFAULT 0,
    cancel_reason VARCHAR(128) NOT NULL DEFAULT '',
    urge_count    INT          NOT NULL DEFAULT 0,
    last_urge_at  BIGINT       NOT NULL DEFAULT 0,
    rated         TINYINT      NOT NULL DEFAULT 0,
    points_granted TINYINT     NOT NULL DEFAULT 0 COMMENT '积分是否已发放，防重复发放',
    created_at    BIGINT       NOT NULL,
    updated_at    BIGINT       NOT NULL,
    UNIQUE KEY uk_order_no (order_no),
    UNIQUE KEY uk_idem (id),
    KEY idx_user_time (user_id, created_at),
    KEY idx_user_status (user_id, status, created_at),
    KEY idx_status_time (status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mp_order_item (
    id         BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id   VARCHAR(40)  NOT NULL,
    dish_id    VARCHAR(32)  NOT NULL,
    dish_name  VARCHAR(128) NOT NULL,
    emoji      VARCHAR(8)   NOT NULL DEFAULT '',
    price      INT          NOT NULL,
    unit       VARCHAR(16)  NOT NULL DEFAULT '份',
    quantity   INT          NOT NULL,
    spicy_id   VARCHAR(16)  NOT NULL DEFAULT '',
    spicy_name VARCHAR(32)  NOT NULL DEFAULT '',
    amount     INT          NOT NULL,
    KEY idx_order (order_id),
    KEY idx_dish (dish_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mp_order_log (
    id         BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id   VARCHAR(40) NOT NULL,
    from_status VARCHAR(16) NOT NULL DEFAULT '',
    to_status  VARCHAR(16) NOT NULL,
    operator   VARCHAR(32) NOT NULL DEFAULT 'system',
    remark     VARCHAR(128) NOT NULL DEFAULT '',
    created_at BIGINT      NOT NULL,
    KEY idx_order (order_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mp_pay_record (
    id             BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id       VARCHAR(40) NOT NULL,
    out_trade_no   VARCHAR(40) NOT NULL,
    transaction_id VARCHAR(64) NOT NULL DEFAULT '',
    amount         INT         NOT NULL,
    status         VARCHAR(16) NOT NULL COMMENT 'CREATED|SUCCESS|FAIL|CLOSED|REFUNDING|REFUNDED',
    channel        VARCHAR(16) NOT NULL DEFAULT 'wechat',
    raw            TEXT        NULL,
    created_at     BIGINT      NOT NULL,
    updated_at     BIGINT      NOT NULL,
    UNIQUE KEY uk_out_trade_no (out_trade_no),
    UNIQUE KEY uk_txn (transaction_id),
    KEY idx_order (order_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mp_idempotency (
    id         BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT       NOT NULL,
    idem_key   VARCHAR(80)  NOT NULL,
    response   TEXT         NULL,
    created_at BIGINT       NOT NULL,
    UNIQUE KEY uk_user_key (user_id, idem_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mp_feedback (
    id         BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id   VARCHAR(40)  NOT NULL,
    user_id    BIGINT       NOT NULL,
    score      TINYINT      NOT NULL DEFAULT 5,
    content    VARCHAR(500) NOT NULL DEFAULT '',
    created_at BIGINT       NOT NULL,
    UNIQUE KEY uk_order (order_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mp_invoice (
    id         BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT       NOT NULL,
    title_type VARCHAR(16)  NOT NULL DEFAULT 'personal',
    title      VARCHAR(128) NOT NULL,
    tax_no     VARCHAR(64)  NOT NULL DEFAULT '',
    email      VARCHAR(128) NOT NULL DEFAULT '',
    is_default TINYINT      NOT NULL DEFAULT 0,
    created_at BIGINT       NOT NULL,
    KEY idx_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mp_refund (
    id         BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id   VARCHAR(40) NOT NULL,
    user_id    BIGINT      NOT NULL,
    amount     INT         NOT NULL,
    reason     VARCHAR(255) NOT NULL DEFAULT '',
    status     VARCHAR(16) NOT NULL DEFAULT 'APPLIED' COMMENT 'APPLIED|APPROVED|REJECTED|REFUNDED',
    refund_id  VARCHAR(64) NOT NULL DEFAULT '',
    created_at BIGINT      NOT NULL,
    updated_at BIGINT      NOT NULL,
    KEY idx_order (order_id),
    KEY idx_user (user_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mp_seq (
    name VARCHAR(64) NOT NULL PRIMARY KEY,
    val  BIGINT      NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

/** 幂等加列：老库升级时用，已存在则跳过 */
async function ensureColumn(conn, table, column, definition) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
    [config.db.database, table, column]
  );
  if (rows[0].c === 0) {
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
    logger.info('column added', { table, column });
  }
}

async function migrate() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    connectTimeout: 10000,
  });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`
    );
    await conn.query(`USE \`${config.db.database}\``);
    for (const sql of DDL) await conn.query(sql);
    /* 老库平滑升级（CREATE TABLE IF NOT EXISTS 不会补列） */
    await ensureColumn(conn, 'mp_order', 'parent_order_id', "parent_order_id VARCHAR(40) NOT NULL DEFAULT '' COMMENT '加菜场景的上游订单'");
    await ensureColumn(conn, 'mp_order', 'store_id', "store_id VARCHAR(32) NOT NULL DEFAULT ''");
    await ensureColumn(conn, 'mp_order', 'brand_id', "brand_id VARCHAR(32) NOT NULL DEFAULT ''");
    await ensureColumn(conn, 'mp_order', 'store_type', "store_type VARCHAR(16) NOT NULL DEFAULT 'DIRECT'");
    await ensureColumn(conn, 'mp_order', 'urge_count', 'urge_count INT NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'mp_order', 'last_urge_at', 'last_urge_at BIGINT NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'mp_order', 'rated', 'rated TINYINT NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'mp_order', 'points_granted', 'points_granted TINYINT NOT NULL DEFAULT 0');
    /* 券表升级为连锁版 */
    await ensureColumn(conn, 'mp_coupon', 'brand_id', "brand_id VARCHAR(32) NOT NULL DEFAULT 'brand_lbz'");
    await ensureColumn(conn, 'mp_coupon', 'store_ids', "store_ids VARCHAR(512) NOT NULL DEFAULT ''");
    await ensureColumn(conn, 'mp_coupon', 'issue_type', "issue_type VARCHAR(16) NOT NULL DEFAULT 'MANUAL'");
    await ensureColumn(conn, 'mp_coupon', 'receive_enabled', 'receive_enabled TINYINT NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'mp_coupon', 'receive_start', 'receive_start BIGINT NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'mp_coupon', 'receive_end', 'receive_end BIGINT NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'mp_coupon', 'day_limit', 'day_limit INT NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'mp_coupon', 'used_count', 'used_count INT NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'mp_coupon', 'created_by', 'created_by BIGINT NOT NULL DEFAULT 0');
    logger.info('migrate done', { tables: DDL.length, db: config.db.database });
    logger.info('提示：若刚从单店版升级，建议执行 `node src/db.js reset` 重建数据（自动导入品牌/门店/账号/主题/券）');
  } finally {
    await conn.end();
  }
}

/* ============================================================ Seed */
const BRAND_ID = 'brand_lbz';

/** 门店清单：3 直营 + 2 加盟，带真实经纬度（北京） */
const SEED_STORES = [
  { id: 'st_dz', code: 'BJ001', name: '老北京麻辣串串香·东直门总店', type: 'DIRECT', region: '华北', city: '北京', address: '东城区东直门内大街 188 号', lat: 39.9403, lng: 116.4216, perCapita: 68 },
  { id: 'st_cy', code: 'BJ002', name: '老北京麻辣串串香·朝阳大悦城店', type: 'DIRECT', region: '华北', city: '北京', address: '朝阳区朝阳北路 101 号大悦城 B1', lat: 39.9245, lng: 116.516, perCapita: 72 },
  { id: 'st_hd', code: 'BJ003', name: '老北京麻辣串串香·中关村店', type: 'DIRECT', region: '华北', city: '北京', address: '海淀区中关村大街 1 号 3 层', lat: 39.9836, lng: 116.3164, perCapita: 70 },
  { id: 'st_ft', code: 'BJ004', name: '老北京麻辣串串香·丰台万达店（加盟）', type: 'FRANCHISE', region: '华北', city: '北京', address: '丰台区南三环西路 16 号万达广场 5 层', lat: 39.8586, lng: 116.295, perCapita: 65, franchisee: '北京味觉餐饮管理有限公司' },
  { id: 'st_tz', code: 'BJ005', name: '老北京麻辣串串香·通州万达店（加盟）', type: 'FRANCHISE', region: '华北', city: '北京', address: '通州区新华西街 60 号万达广场 4 层', lat: 39.9097, lng: 116.6564, perCapita: 64, franchisee: '通州蜀香餐饮合伙企业' },
];

/**
 * seed 用的口令散列（仅初始化演示账号）
 *
 * 参数必须与 admin-server/src/staffAuth.js 的 hashPassword **完全一致**
 * （scrypt / keylen 64 / 16 字节 hex 盐），否则 seed 出来的账号登不进管理端。
 * 这里不做成依赖，是为了让两个服务保持目录独立。
 */
function hashPasswordForSeed(password) {
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  return { hash: crypto.scryptSync(String(password), salt, 64).toString('hex'), salt };
}

async function seed() {
  // 菜单单一事实来源：本服务自带的种子数据（data/menuSeed.js，与前端 mock 同步维护）
  const mock = require('../data/menuSeed');
  const now = Date.now();
  const DAY = 86400000;

  /* ---------------- 品牌 ---------------- */
  await execute(
    `INSERT INTO mp_brand (id, name, logo, notice, contact, status, created_at, updated_at)
     VALUES (?,?,?,?,?,1,?,?)
     ON DUPLICATE KEY UPDATE name=VALUES(name),notice=VALUES(notice),contact=VALUES(contact),updated_at=VALUES(updated_at)`,
    [BRAND_ID, '老北京麻辣烫串串香（集团）', '🌶️', '现串现涮 · 每日 11:00 开锅 · 全国连锁', '400-888-6666', now, now]
  );

  /* ---------------- 门店 ---------------- */
  for (const s of SEED_STORES) {
    await execute(
      `INSERT INTO mp_store
       (id, brand_id, code, name, type, franchisee, region, city, address, phone, latitude, longitude,
        open_time, per_capita, tables_json, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name),type=VALUES(type),franchisee=VALUES(franchisee),
         region=VALUES(region),city=VALUES(city),address=VALUES(address),latitude=VALUES(latitude),
         longitude=VALUES(longitude),per_capita=VALUES(per_capita),updated_at=VALUES(updated_at)`,
      [
        s.id, BRAND_ID, s.code, s.name, s.type, s.franchisee || '', s.region, s.city, s.address,
        '010' + (88000000 + Math.floor(Math.random() * 999999)), s.lat, s.lng,
        '11:00 - 次日 02:00', s.perCapita, JSON.stringify(mock.SHOP.tables || []), now, now,
      ]
    );
  }

  /* ---------------- 分类 / 菜品（品牌级） ---------------- */
  for (let i = 0; i < mock.CATEGORIES.length; i++) {
    const c = mock.CATEGORIES[i];
    await execute(
      `INSERT INTO mp_category (id,brand_id,name,emoji,sort,status) VALUES (?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE name=VALUES(name),emoji=VALUES(emoji),sort=VALUES(sort),status=1`,
      [c.id, BRAND_ID, c.name, c.emoji, i]
    );
  }

  for (let i = 0; i < mock.DISHES.length; i++) {
    const d = mock.DISHES[i];
    await execute(
      `INSERT INTO mp_dish (id,brand_id,category_id,name,description,emoji,image,price,unit,spicy,tags,status,sort,updated_at)
       VALUES (?,?,?,?,?,?,'',?,?,?,?,1,?,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name),description=VALUES(description),emoji=VALUES(emoji),
         price=VALUES(price),unit=VALUES(unit),spicy=VALUES(spicy),tags=VALUES(tags),status=1,sort=VALUES(sort),updated_at=VALUES(updated_at)`,
      [d.id, BRAND_ID, d.categoryId, d.name, d.desc || '', d.emoji, d.price, d.unit, d.spicy ? 1 : 0, JSON.stringify(d.tags || []), i, now]
    );
  }

  /* ---------------- 门店菜品：总部菜单下发到门店 ---------------- */
  for (const s of SEED_STORES) {
    for (const d of mock.DISHES) {
      /* 加盟店演示差异：丰台店 2 款停售、通州店库存更少 */
      let status = 1;
      let stock = d.stock;
      if (s.id === 'st_ft' && (d.id === 'd205' || d.id === 'd403')) status = 0;
      if (s.id === 'st_tz') stock = Math.max(20, Math.round(d.stock * 0.6));
      await execute(
        `INSERT INTO mp_store_dish (store_id, dish_id, price_override, stock, sold, status, updated_at)
         VALUES (?,?,0,?,0,?,?)
         ON DUPLICATE KEY UPDATE stock=VALUES(stock),status=VALUES(status),updated_at=VALUES(updated_at)`,
        [s.id, d.id, stock, status, now]
      );
    }
  }

  /* ---------------- 锅底 / 蘸料 / 辣度 ---------------- */
  for (let i = 0; i < mock.SOUPS.length; i++) {
    const s = mock.SOUPS[i];
    await execute(
      `INSERT INTO mp_soup (id,brand_id,name,price,emoji,description,recommended,sort,status) VALUES (?,?,?,?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE name=VALUES(name),price=VALUES(price),emoji=VALUES(emoji),
         description=VALUES(description),recommended=VALUES(recommended),sort=VALUES(sort),status=1`,
      [s.id, BRAND_ID, s.name, s.price, s.emoji, s.desc || '', s.recommended ? 1 : 0, i]
    );
  }
  for (let i = 0; i < mock.DIPS.length; i++) {
    const d = mock.DIPS[i];
    await execute(
      `INSERT INTO mp_dip (id,brand_id,name,price,emoji,sort,status) VALUES (?,?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE name=VALUES(name),price=VALUES(price),emoji=VALUES(emoji),sort=VALUES(sort),status=1`,
      [d.id, BRAND_ID, d.name, d.price, d.emoji, i]
    );
  }
  for (let i = 0; i < mock.SPICY_OPTIONS.length; i++) {
    const s = mock.SPICY_OPTIONS[i];
    await execute(
      `INSERT INTO mp_spicy (id,name,color,sort) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name),color=VALUES(color),sort=VALUES(sort)`,
      [s.id, s.name, s.color, i]
    );
  }

  /* ---------------- 管理端账号（角色覆盖 5 类） ---------------- */
  const SEED_STAFF = [
    { account: 'admin', pwd: 'Admin@123456', name: '品牌管理员', role: 'BRAND_ADMIN', allStores: 1, stores: [] },
    { account: 'region_north', pwd: 'Region@123456', name: '华北区域经理', role: 'REGION_MANAGER', allStores: 0, region: '华北', stores: [] },
    { account: 'mgr_dz', pwd: 'Store@123456', name: '东直门店长', role: 'STORE_MANAGER', allStores: 0, stores: ['st_dz'] },
    { account: 'staff_dz', pwd: 'Staff@123456', name: '东直门店员', role: 'STAFF', allStores: 0, stores: ['st_dz'] },
    { account: 'mgr_cy', pwd: 'Store@123456', name: '朝阳店长', role: 'STORE_MANAGER', allStores: 0, stores: ['st_cy'] },
    { account: 'owner_ft', pwd: 'Franchise@123456', name: '丰台加盟商', role: 'FRANCHISE_OWNER', allStores: 0, stores: ['st_ft'] },
  ];
  for (const s of SEED_STAFF) {
    const exist = await queryOne('SELECT id FROM mp_staff WHERE brand_id = ? AND account = ?', [BRAND_ID, s.account]);
    if (exist) continue;
    const { hash, salt } = hashPasswordForSeed(s.pwd);
    const r = await execute(
      `INSERT INTO mp_staff (brand_id, account, password_hash, password_salt, name, phone, role, region, all_stores,
        must_change_pwd, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,1,?,?)`,
      [BRAND_ID, s.account, hash, salt, s.name, '', s.role, s.region || '', s.allStores, now, now]
    );
    for (const sid of s.stores) {
      await execute('INSERT INTO mp_staff_store (staff_id, store_id) VALUES (?,?) ON DUPLICATE KEY UPDATE staff_id=staff_id', [r.insertId, sid]);
    }
  }

  /* ---------------- 主题 ---------------- */
  const themeService = require('./themeService');
  const P = themeService.PRESETS;
  const SEED_THEMES = [
    { id: 'th_normal', storeId: '', preset: 'NORMAL', priority: 0, start: 0, end: 0, status: 1, desc: '日常营业默认主题' },
    { id: 'th_holiday', storeId: '', preset: 'HOLIDAY', priority: 20, start: now - 7 * DAY, end: now + 7 * DAY, status: 1, desc: '节假日氛围，正红+金黄' },
    { id: 'th_member', storeId: '', preset: 'MEMBER_DAY', priority: 10, start: 0, end: 0, status: 0, desc: '会员日黑金主题（未启用，可一键切换）' },
    { id: 'th_dz_open', storeId: 'st_dz', preset: 'CAMPAIGN', priority: 30, start: now - DAY, end: now + 30 * DAY, status: 1, desc: '东直门总店开业庆（门店级覆盖品牌级）' },
  ];
  for (const t of SEED_THEMES) {
    const pre = P[t.preset];
    await execute(
      `INSERT INTO mp_theme (id, brand_id, store_id, name, type, tokens_json, description, start_at, end_at, priority, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name),tokens_json=VALUES(tokens_json),description=VALUES(description),
         start_at=VALUES(start_at),end_at=VALUES(end_at),priority=VALUES(priority),updated_at=VALUES(updated_at)`,
      [t.id, BRAND_ID, t.storeId, pre.name, pre.type, JSON.stringify(pre.tokens), t.desc, t.start, t.end, t.priority, t.status, now, now]
    );
  }

  /* ---------------- 优惠券模板 ---------------- */
  const SEED_COUPONS = [
    { id: 'cp1', name: '新客立减券', type: 'CASH', value: 500, threshold: 0, issueType: 'NEW_USER', receive: 0, scope: '全品牌通用', expire: '2026-12-31', perUser: 1, total: 999999, dayLimit: 0, stores: [] },
    { id: 'cp2', name: '满 50 减 10', type: 'CASH', value: 1000, threshold: 5000, issueType: 'RECEIVE', receive: 1, scope: '全品牌通用（不含锅底）', expire: '2026-12-31', perUser: 2, total: 5000, dayLimit: 1, stores: [] },
    { id: 'cp3', name: '锅底免费券', type: 'SOUP', value: 1800, threshold: 0, issueType: 'RECEIVE', receive: 1, scope: '限锅底', expire: '2026-12-31', perUser: 1, total: 2000, dayLimit: 0, stores: [] },
    { id: 'cp4', name: '会员日 8.8 折', type: 'DISCOUNT', value: 88, threshold: 3000, issueType: 'CAMPAIGN', receive: 1, scope: '会员日专享', expire: '2026-12-31', perUser: 1, total: 1000, dayLimit: 0, stores: [] },
    { id: 'cp5', name: '朝阳大悦城店专享 8 元券', type: 'CASH', value: 800, threshold: 2000, issueType: 'RECEIVE', receive: 1, scope: '限朝阳大悦城店', expire: '2026-12-31', perUser: 1, total: 500, dayLimit: 0, stores: ['st_cy'] },
  ];
  for (const c of SEED_COUPONS) {
    await execute(
      `INSERT INTO mp_coupon
       (id, brand_id, name, type, value, threshold, scope, store_ids, issue_type, receive_enabled,
        receive_start, receive_end, day_limit, total, issued, per_user, used_count, expire_at, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?,0,?,0,?,1,0,?,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name),type=VALUES(type),value=VALUES(value),threshold=VALUES(threshold),
         scope=VALUES(scope),store_ids=VALUES(store_ids),issue_type=VALUES(issue_type),receive_enabled=VALUES(receive_enabled),
         day_limit=VALUES(day_limit),total=VALUES(total),per_user=VALUES(per_user),expire_at=VALUES(expire_at),status=1,updated_at=VALUES(updated_at)`,
      [c.id, BRAND_ID, c.name, c.type, c.value, c.threshold, c.scope, JSON.stringify(c.stores), c.issueType, c.receive, c.dayLimit, c.total, c.perUser, c.expire, now, now]
    );
  }

  logger.info('seed done', {
    brand: BRAND_ID,
    stores: SEED_STORES.length,
    categories: mock.CATEGORIES.length,
    dishes: mock.DISHES.length,
    storeDishRows: SEED_STORES.length * mock.DISHES.length,
    staff: SEED_STAFF.length,
    themes: SEED_THEMES.length,
    coupons: SEED_COUPONS.length,
  });
}

async function reset() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });
  const tables = DDL.map((s) => (s.match(/CREATE TABLE IF NOT EXISTS (\w+)/) || [])[1]).filter(Boolean);
  await conn.query('SET FOREIGN_KEY_CHECKS=0');
  for (const t of tables) await conn.query('DROP TABLE IF EXISTS `' + t + '`');
  await conn.query('SET FOREIGN_KEY_CHECKS=1');
  await conn.end();
  await close();

  /* 同时清 Redis：自增 ID 会重置，若不清限流/锁/缓存，会跟旧数据错位 */
  try {
    const redis = require('./redis');
    redis.init();
    if (await redis.waitReady(1500)) {
      const n = await redis.flushAppKeys();
      logger.info('redis keys flushed', { deleted: n });
    }
    await redis.quit();
  } catch (e) {
    logger.warn('redis flush skipped', { message: e.message });
  }

  await migrate();
  await seed();
  logger.info('reset done');
}

module.exports = { init, query, queryOne, execute, tx, nextSeq, health, close, migrate, seed, reset, get pool() { return pool; } };

/* CLI: node src/db.js migrate|seed|reset */
if (require.main === module) {
  const cmd = process.argv[2] || 'migrate';
  (async () => {
    try {
      if (cmd === 'migrate') await migrate();
      else if (cmd === 'seed') await seed();
      else if (cmd === 'reset') await reset();
      else throw new Error('未知命令: ' + cmd);
      await close();
      process.exit(0);
    } catch (e) {
      logger.error('db cli failed', { cmd, message: e.message });
      process.exit(1);
    }
  })();
}
