/**
 * 团购券核销核心服务
 * 管理端（店员代客核销）与小程序端（用户自助核销）**共用同一份逻辑**，
 * 避免出现「店员核销有防重、用户自助没有」这种安全缺口。
 */
const db = require('./db');
const config = require('./config');
const logger = require('./logger');
const redis = require('./redis');
const { getProvider, normalizeCode } = require('./voucherProvider');
const { bizError, notFound, CODES } = require('./errors');

/**
 * 核销
 * @param {object} p
 *   code       券码
 *   storeId    门店（必须落在操作者授权范围内，由调用方先做 assertStore）
 *   channel    STAFF | SELF
 *   staffId    核销员工（STAFF 通道）
 *   userId     核销用户（SELF 通道）
 *   operator   操作者名称（写审计用）
 */
async function verifyVoucher(p) {
  const code = normalizeCode(p.code);
  if (!code) throw bizError(CODES.PARAM_INVALID, '请输入券码');
  if (!p.storeId) throw bizError(CODES.PARAM_INVALID, '请选择核销门店');

  /* 频次限制：同一操作者 + 同一券码维度，防止脚本暴力试码 */
  const rl = await redis.rateLimit.hit('voucher:' + (p.staffId ? 's' + p.staffId : 'u' + p.userId) , 30, 60);
  if (!rl.allowed) throw bizError(CODES.RATE_LIMITED, '核销过于频繁，请稍后再试');

  const store = await db.queryOne('SELECT * FROM mp_store WHERE id = ? AND status = 1', [p.storeId]);
  if (!store) throw notFound('门店不存在或已停业');

  /* ① 本地查重：已核销的直接把「什么时候、在哪家店、谁核销的」告诉店员 */
  const exist = await db.queryOne('SELECT * FROM mp_voucher WHERE platform = ? AND code = ?', [
    p.platform || 'MEITUAN', code,
  ]);
  if (exist) {
    const byStore = await db.queryOne('SELECT name FROM mp_store WHERE id = ?', [exist.store_id]);
    const detail = `${exist.verified_at ? new Date(Number(exist.verified_at)).toLocaleString('zh-CN') : ''} 在「${byStore ? byStore.name : exist.store_id}」`;
    throw bizError(CODES.STATE_CONFLICT, `该券已核销（${detail}）`);
  }

  /* ② 问平台（mock 时走本地规则） */
  const provider = getProvider();
  const info = await provider.verify({ code, storeId: p.storeId, store });

  /* ③ 面值上限保护：大额券要求二次确认，防内部作弊 */
  if (info.faceValue > config.chain.voucherMaxFaceValue) {
    throw bizError(
      CODES.PARAM_INVALID,
      `券面值 ¥${(info.faceValue / 100).toFixed(2)} 超过单笔核销上限（¥${(config.chain.voucherMaxFaceValue / 100).toFixed(2)}），请联系值班经理`
    );
  }

  const now = Date.now();
  let inserted;
  try {
    /**
     * ④ 落库：uk(platform, code) 是并发下的最后一道保险。
     * 两个请求同时走到这里，只有一个能插入成功，另一个撞唯一键 —— 从根上杜绝重复核销。
     */
    inserted = await db.execute(
      `INSERT INTO mp_voucher
       (platform, code, brand_id, store_id, deal_id, product_name, face_value, quantity,
        status, verified_by, verified_at, user_id, channel, raw, created_at)
       VALUES (?,?,?,?,?,?,?,?, 'VERIFIED', ?,?,?,?,?,?)`,
      [
        p.platform || 'MEITUAN', code, store.brand_id, p.storeId,
        info.dealId, info.productName, info.faceValue, info.quantity,
        p.staffId || 0, now, p.userId || 0, p.channel || 'STAFF',
        JSON.stringify(info.raw || {}).slice(0, 60000), now,
      ]
    );
  } catch (e) {
    if (e && e.errno === 1062) {
      throw bizError(CODES.STATE_CONFLICT, '该券已被核销，请勿重复操作');
    }
    throw e;
  }

  logger.info('voucher verified', {
    code: code.slice(0, 4) + '****', storeId: p.storeId, faceValue: info.faceValue,
    channel: p.channel, staffId: p.staffId || 0, userId: p.userId || 0,
  });

  return {
    id: inserted.insertId,
    code,
    platform: p.platform || 'MEITUAN',
    storeId: p.storeId,
    storeName: store.name,
    dealId: info.dealId,
    productName: info.productName,
    faceValue: info.faceValue,
    quantity: info.quantity,
    channel: p.channel || 'STAFF',
    verifiedAt: now,
    verifiedAtText: new Date(now).toLocaleString('zh-CN'),
  };
}

/** 撤销核销（误操作/顾客退款），需要更高权限并留痕 */
async function refundVoucher(voucherId, operator) {
  const row = await db.queryOne('SELECT * FROM mp_voucher WHERE id = ?', [voucherId]);
  if (!row) throw notFound('核销记录不存在');
  if (row.status !== 'VERIFIED') throw bizError(CODES.STATE_CONFLICT, '该记录当前状态不可撤销');

  const provider = getProvider();
  const r = await provider.refund({ code: row.code, storeId: row.store_id });

  await db.tx(async (tx) => {
    const upd = await tx.execute(
      "UPDATE mp_voucher SET status = 'REFUNDED', raw = ? WHERE id = ? AND status = 'VERIFIED'",
      [JSON.stringify(Object.assign({}, JSON.parse(row.raw || '{}'), { refund: r.raw })).slice(0, 60000), voucherId]
    );
    if (upd.affectedRows === 0) throw bizError(CODES.STATE_CONFLICT, '该记录已被其他操作变更');
  });
  logger.warn('voucher refunded', { voucherId, by: operator });
  return { ok: true, refundBy: provider.name };
}

/**
 * 注意：核销记录列表（listVouchers）在 admin-server 侧，
 * 它带门店范围过滤与统计，属于管理端查询，本服务不提供。
 */
module.exports = { verifyVoucher, refundVoucher };
