/**
 * 团购券核销（美团团购 / 可扩展其他平台）
 *
 * ── 设计要点 ──
 *   1. Provider 可插拔：mock（本地规则，无凭据也能全链路跑通）/ meituan（真实开放平台）
 *      —— 上线只需改 `.env` 的 VOUCHER_PROVIDER，业务代码零改动
 *   2. 顺序是「先查本地 → 再问平台 → 再落库」，三层都能挡住重复核销：
 *        本地唯一键 uk(platform, code)  ← 并发下的最后一道保险
 *        平台侧返回「已核销」→ 原样透传给店员（含核销时间/门店，便于追责）
 *   3. 面值上限保护：超过阈值需要二次确认，防内部人员拿大额券作弊
 *   4. 核销即审计：谁、在哪家店、什么时间、什么券、面值多少，全部留痕
 *   5. 支持两种通道：STAFF（店员代客核销）/ SELF（用户小程序自助核销）
 */
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');
const { bizError, CODES } = require('./errors');

/* ============================================================ Provider 注册表 */
const providers = {};

/** 本地规则 Provider —— 没有美团凭据时用它，行为可控、可测试 */
providers.mock = {
  name: 'mock',
  async verify({ code, storeId }) {
    const c = String(code || '').toUpperCase();
    if (!/^MT\d{8,18}$/.test(c)) {
      throw bizError(CODES.PARAM_INVALID, '券码格式不正确（应以 MT 开头，共 10-20 位）');
    }
    /* 按前缀映射到不同团购套餐，方便演示不同面值 */
    const table = [
      { prefix: 'MT168', dealId: 'DEAL_168', productName: '招牌串串双人餐', faceValue: 16800, quantity: 1 },
      { prefix: 'MT128', dealId: 'DEAL_128', productName: '四人畅吃套餐', faceValue: 12800, quantity: 1 },
      { prefix: 'MT88', dealId: 'DEAL_88', productName: '双人畅吃套餐', faceValue: 8800, quantity: 1 },
      { prefix: 'MT299', dealId: 'DEAL_299', productName: '六人聚餐套餐', faceValue: 29900, quantity: 1 },
    ];
    const hit = table.find((t) => c.indexOf(t.prefix) === 0) || {
      dealId: 'DEAL_CASH',
      productName: '美团代金券',
      faceValue: 5000,
      quantity: 1,
    };
    return {
      dealId: hit.dealId,
      productName: hit.productName,
      faceValue: hit.faceValue,
      quantity: hit.quantity,
      raw: { provider: 'mock', code: c, storeId },
    };
  },
  async refund() {
    return { ok: true, raw: { provider: 'mock', refunded: true } };
  },
};

/**
 * 美团开放平台 Provider
 *
 * 说明：美团开放平台的团购券核销接口需要 appKey/appSecret 签名（具体字段名与签名串
 * 以你实际开通的接口文档为准）。这里给出的是标准接入骨架：签名、请求、错误映射、
 * 平台侧「已核销」状态识别都已经写好，拿到凭据后只需按文档核对 path 与参数字段名。
 */
providers.meituan = {
  name: 'meituan',
  sign(params, secret) {
    const keys = Object.keys(params).sort();
    const raw = secret + keys.map((k) => k + params[k]).join('') + secret;
    return crypto.createHash('md5').update(raw, 'utf8').digest('hex').toUpperCase();
  },
  async call(path, params) {
    const { appKey, appSecret, apiBase } = config.voucher.meituan;
    if (!appKey || !appSecret) throw bizError(CODES.UNAVAILABLE, '美团开放平台凭据未配置（MEITUAN_APP_KEY / SECRET）');
    const body = Object.assign({ appKey, timestamp: Math.floor(Date.now() / 1000) }, params);
    body.sign = this.sign(body, appSecret);
    const res = await fetch(apiBase + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw bizError(CODES.UPSTREAM_ERROR, '美团接口返回异常');
    }
    return json;
  },
  async verify({ code }) {
    const r = await this.call('/openapi/deal/coupon/verify', { couponCode: code, count: 1 });
    /* 平台侧常见状态：已核销 / 已过期 / 不存在 —— 都要原样告诉店员，而不是笼统报错 */
    if (r && r.code === 'COUPON_ALREADY_VERIFIED') {
      throw bizError(CODES.STATE_CONFLICT, '该券已在美团侧核销过');
    }
    if (!r || r.status !== 'success') {
      throw bizError(CODES.UPSTREAM_ERROR, (r && r.message) || '美团券校验失败');
    }
    return {
      dealId: r.dealId || '',
      productName: r.dealTitle || '美团团购券',
      faceValue: Number(r.faceValue || 0),
      quantity: Number(r.count || 1),
      raw: r,
    };
  },
  async refund({ code }) {
    const r = await this.call('/openapi/deal/coupon/refund', { couponCode: code });
    return { ok: !!(r && r.status === 'success'), raw: r };
  },
};

function getProvider() {
  const p = providers[config.voucher.provider];
  if (!p) throw bizError(CODES.PARAM_INVALID, '未知的团购券服务商: ' + config.voucher.provider);
  return p;
}

/* ============================================================ 核心服务 */
function normalizeCode(code) {
  return String(code || '')
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .slice(0, 64);
}

module.exports = { providers, getProvider, normalizeCode };
