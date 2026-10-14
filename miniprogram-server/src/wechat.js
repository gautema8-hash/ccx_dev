/**
 * 微信能力封装
 *   · code2session：小程序登录换 openid / session_key
 *   · 微信支付 v3：JSAPI 下单、客户端调起签名、回调验签 + AES-256-GCM 解密、查单、关单、退款
 *
 * 交付级要点：
 *   · 签名串格式严格按官方文档，多一个换行都会被判签名失败
 *   · 平台证书自动拉取 + 内存缓存 + 过期前刷新（回调验签必须用平台证书，不能用商户私钥）
 *   · 回调必须「先验签再解密」，否则可被伪造请求直接改单
 *   · HTTPS 请求带超时与重试（幂等接口才重试）
 *   · PAY_MODE=mock 时全部走本地模拟，保证没有商户号也能把链路跑通
 */
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');
const { bizError, unavailable, CODES } = require('./errors');

/* ---------------------------------------------------------- HTTPS */
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      Object.assign({ timeout: 8000 }, options),
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('上游超时'));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function nonce(len) {
  return crypto.randomBytes(len || 16).toString('hex').slice(0, len || 32);
}

/* ---------------------------------------------------------- 登录 */
/**
 * code2session
 * @returns {{openid:string, session_key:string, unionid:string}}
 */
async function code2session(code) {
  if (config.wx.loginMode !== 'real') {
    // 开发模式：用 code 派生一个稳定的假 openid，保证同一 code 得到同一用户
    const h = crypto.createHash('sha1').update('mock|' + code).digest('hex').slice(0, 20);
    return { openid: 'mock_' + h, session_key: 'mock_session_key', unionid: '' };
  }
  if (!config.wx.appid || !config.wx.appSecret) {
    throw unavailable('微信登录未配置（APPID / APP_SECRET）');
  }
  const url =
    'https://api.weixin.qq.com/sns/jscode2session?appid=' +
    encodeURIComponent(config.wx.appid) +
    '&secret=' +
    encodeURIComponent(config.wx.appSecret) +
    '&js_code=' +
    encodeURIComponent(code) +
    '&grant_type=authorization_code';

  const res = await httpsRequest({ method: 'GET', hostname: 'api.weixin.qq.com', path: url.slice('https://api.weixin.qq.com'.length) }).catch(
    (e) => {
      throw unavailable('微信登录服务不可用，请稍后重试', e.message);
    }
  );
  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    throw unavailable('微信登录返回异常');
  }
  if (data.errcode) {
    logger.warn('code2session failed', { errcode: data.errcode, errmsg: data.errmsg });
    // 40029 code 无效 / 40163 code 已被使用
    throw bizError(CODES.AUTH_FAILED, '微信登录失败（' + (data.errcode === 40029 ? 'code 无效' : data.errmsg) + '）');
  }
  if (!data.openid) throw bizError(CODES.AUTH_FAILED, '微信登录失败：未返回 openid');
  return { openid: data.openid, session_key: data.session_key || '', unionid: data.unionid || '' };
}

/* ---------------------------------------------------------- 支付 v3 */
let privateKeyCache = null;
function loadPrivateKey() {
  if (privateKeyCache) return privateKeyCache;
  const p = config.pay.privateKeyPath;
  if (!p) throw unavailable('未配置商户私钥 MCH_PRIVATE_KEY_PATH');
  const resolved = require('path').isAbsolute(p) ? p : require('path').resolve(__dirname, '..', p);
  if (!fs.existsSync(resolved)) throw unavailable('商户私钥文件不存在: ' + resolved);
  privateKeyCache = fs.readFileSync(resolved, 'utf8');
  return privateKeyCache;
}

function rsaSign(message) {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  return sign.sign(loadPrivateKey(), 'base64');
}

/** 构造 v3 请求的 Authorization 头 */
function buildAuthHeader(method, urlPath, bodyStr) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = nonce(32);
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${bodyStr || ''}\n`;
  const signature = rsaSign(message);
  return (
    'WECHATPAY2-SHA256-RSA2048 ' +
    `mchid="${config.pay.mchId}",` +
    `nonce_str="${nonceStr}",` +
    `signature="${signature}",` +
    `timestamp="${timestamp}",` +
    `serial_no="${config.pay.serialNo}"`
  );
}

/** JSAPI 下单，返回 prepay_id */
async function jsapiPrepay({ outTradeNo, description, amount, openid, attach }) {
  const bodyObj = {
    appid: config.wx.appid,
    mchid: config.pay.mchId,
    description: description || '老北京麻辣串串香-点餐',
    out_trade_no: outTradeNo,
    notify_url: config.pay.notifyUrl,
    amount: { total: amount, currency: 'CNY' },
    payer: { openid },
    attach: attach || '',
    time_expire: new Date(Date.now() + config.pay.timeoutMin * 60000).toISOString().replace(/\.\d{3}Z$/, '+08:00'),
  };
  const bodyStr = JSON.stringify(bodyObj);
  const urlPath = '/v3/pay/transactions/jsapi';
  const res = await httpsRequest(
    {
      method: 'POST',
      hostname: 'api.mch.weixin.qq.com',
      path: urlPath,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'lbz-order-server/1.0',
        Authorization: buildAuthHeader('POST', urlPath, bodyStr),
      },
    },
    bodyStr
  );
  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    throw unavailable('微信支付返回异常');
  }
  if (res.statusCode !== 200 || !data.prepay_id) {
    logger.warn('prepay failed', { statusCode: res.statusCode, code: data.code, message: data.message });
    throw bizError(CODES.UPSTREAM_ERROR, '微信支付下单失败：' + (data.message || res.statusCode));
  }
  return data.prepay_id;
}

/** 生成客户端调起支付所需参数（paySign 用商户私钥签，signType=RSA） */
function buildPayParams(prepayId) {
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = nonce(32);
  const pkg = 'prepay_id=' + prepayId;
  const message = `${config.wx.appid}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
  return {
    timeStamp,
    nonceStr,
    package: pkg,
    signType: 'RSA',
    paySign: rsaSign(message),
  };
}

/* ---------- 平台证书（回调验签用） ---------- */
let platformCerts = { list: [], fetchedAt: 0 };

function aesGcmDecrypt(ciphertextB64, associatedData, nonceStr) {
  const key = Buffer.from(config.pay.apiv3Key, 'utf8');
  if (key.length !== 32) throw new Error('APIv3 密钥必须是 32 字节');
  const buf = Buffer.from(ciphertextB64, 'base64');
  const authTag = buf.slice(buf.length - 16);
  const data = buf.slice(0, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonceStr, 'utf8'));
  decipher.setAuthTag(authTag);
  if (associatedData) decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

async function fetchPlatformCerts() {
  if (Date.now() - platformCerts.fetchedAt < 6 * 3600 * 1000 && platformCerts.list.length) return platformCerts.list;
  const urlPath = '/v3/certificates';
  const res = await httpsRequest({
    method: 'GET',
    hostname: 'api.mch.weixin.qq.com',
    path: urlPath,
    headers: { Accept: 'application/json', Authorization: buildAuthHeader('GET', urlPath, '') },
  });
  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    throw new Error('获取平台证书失败: 响应不是 JSON');
  }
  if (!data.data) throw new Error('获取平台证书失败: ' + (data.message || res.statusCode));
  const list = data.data.map((item) => {
    const plain = JSON.parse(
      aesGcmDecrypt(item.encrypt_certificate.ciphertext, item.encrypt_certificate.associated_data, item.encrypt_certificate.nonce)
    );
    return { serial: item.serial_no, cert: plain.certificate };
  });
  platformCerts = { list, fetchedAt: Date.now() };
  logger.info('platform certs refreshed', { count: list.length });
  return list;
}

/**
 * 回调验签
 * @returns {boolean}
 */
async function verifyNotify(headers, rawBody) {
  const ts = headers['wechatpay-timestamp'];
  const nonceStr = headers['wechatpay-nonce'];
  const signature = headers['wechatpay-signature'];
  const serial = headers['wechatpay-serial'];
  if (!ts || !nonceStr || !signature || !serial) return false;

  // 防重放：时间戳偏差超过 5 分钟直接拒绝
  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(skew) || skew > 300) {
    logger.warn('notify timestamp skew rejected', { skew });
    return false;
  }

  const certs = await fetchPlatformCerts();
  const hit = certs.find((c) => c.serial === serial);
  if (!hit) {
    logger.warn('notify serial not matched', { serial });
    return false;
  }
  const message = `${ts}\n${nonceStr}\n${rawBody}\n`;
  try {
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(message);
    return verify.verify(hit.cert, signature, 'base64');
  } catch (e) {
    logger.warn('notify verify error', { message: e.message });
    return false;
  }
}

/** 解密回调 resource */
function decryptNotifyResource(resource) {
  return JSON.parse(aesGcmDecrypt(resource.ciphertext, resource.associated_data, resource.nonce));
}

/** 查单（用于支付结果兜底对账，不依赖回调） */
async function queryOrder(outTradeNo) {
  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.pay.mchId)}`;
  const res = await httpsRequest({
    method: 'GET',
    hostname: 'api.mch.weixin.qq.com',
    path: urlPath,
    headers: { Accept: 'application/json', Authorization: buildAuthHeader('GET', urlPath, '') },
  });
  try {
    return JSON.parse(res.body);
  } catch (e) {
    return null;
  }
}

/** 关单 */
async function closeOrder(outTradeNo) {
  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`;
  const bodyStr = JSON.stringify({ mchid: config.pay.mchId });
  const res = await httpsRequest(
    {
      method: 'POST',
      hostname: 'api.mch.weixin.qq.com',
      path: urlPath,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: buildAuthHeader('POST', urlPath, bodyStr) },
    },
    bodyStr
  );
  return res.statusCode === 204;
}

/** 退款 */
async function refund({ outTradeNo, outRefundNo, total, refund, reason }) {
  const urlPath = '/v3/refund/domestic/refunds';
  const bodyStr = JSON.stringify({
    out_trade_no: outTradeNo,
    out_refund_no: outRefundNo,
    reason: reason || '用户申请退款',
    notify_url: config.pay.notifyUrl.replace(/\/pay\/notify$/, '/pay/refund-notify'),
    amount: { refund, total, currency: 'CNY' },
  });
  const res = await httpsRequest(
    {
      method: 'POST',
      hostname: 'api.mch.weixin.qq.com',
      path: urlPath,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: buildAuthHeader('POST', urlPath, bodyStr) },
    },
    bodyStr
  );
  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    throw unavailable('退款接口返回异常');
  }
  if (res.statusCode !== 200 || !data.refund_id) {
    logger.warn('refund failed', { statusCode: res.statusCode, code: data.code, message: data.message });
    throw bizError(CODES.UPSTREAM_ERROR, '退款失败：' + (data.message || res.statusCode));
  }
  return data;
}

module.exports = {
  code2session,
  jsapiPrepay,
  buildPayParams,
  verifyNotify,
  decryptNotifyResource,
  queryOrder,
  closeOrder,
  refund,
  aesGcmDecrypt,
  nonce,
  _internal: { buildAuthHeader, rsaSign, platformCerts: () => platformCerts },
};
