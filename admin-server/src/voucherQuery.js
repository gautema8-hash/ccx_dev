/**
 * 团购券核销记录查询（管理系统后端）
 *
 * 为什么在这里：带「门店范围过滤 + 面值合计」的查询是管理端专用能力，
 * 小程序后端只保留核销（verify）与撤销（refund）两个**领域动作**。
 *
 * 门店范围不在本函数内断言，由调用方（routes/admin.js）先 assertStore 再查。
 */
const db = require('./db');

/**
 * @param {object} scope rbac scope（含 allStores / storeIds）
 * @param {object} q { storeId, from, to, status, keyword, page, size }
 */
async function listVouchers(scope, q) {
  const params = [];
  let where = 'WHERE 1=1';
  if (q.storeId) {
    where += ' AND v.store_id = ?';
    params.push(String(q.storeId));
  } else if (!scope.allStores) {
    const ids = scope.storeIds || [];
    if (!ids.length) return { list: [], total: 0, totalAmount: 0, page: 1, size: 0 };
    where += ` AND v.store_id IN (${ids.map(() => '?').join(',')})`;
    params.push.apply(params, ids);
  }
  if (q.from) {
    where += ' AND v.created_at >= ?';
    params.push(Number(q.from));
  }
  if (q.to) {
    where += ' AND v.created_at <= ?';
    params.push(Number(q.to));
  }
  if (q.status) {
    where += ' AND v.status = ?';
    params.push(String(q.status));
  }
  if (q.keyword) {
    where += ' AND (v.code LIKE ? OR v.product_name LIKE ?)';
    const kw = '%' + String(q.keyword).slice(0, 32) + '%';
    params.push(kw, kw);
  }

  const page = Math.min(10000, Math.max(1, Number(q.page) || 1));
  const size = Math.min(100, Math.max(1, Number(q.size) || 20));

  const totalRow = await db.queryOne(
    `SELECT COUNT(*) AS c, COALESCE(SUM(face_value),0) AS amount FROM mp_voucher v ${where}`,
    params
  );
  const rows = await db.query(
    `SELECT v.*, s.name AS store_name FROM mp_voucher v LEFT JOIN mp_store s ON s.id = v.store_id
     ${where} ORDER BY v.created_at DESC LIMIT ? OFFSET ?`,
    params.concat([size, (page - 1) * size])
  );
  return {
    total: Number(totalRow.c),
    totalAmount: Number(totalRow.amount),
    page,
    size,
    list: rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      code: r.code,
      storeId: r.store_id,
      storeName: r.store_name,
      productName: r.product_name,
      faceValue: Number(r.face_value),
      faceValueText: (Number(r.face_value) / 100).toFixed(2),
      status: r.status,
      channel: r.channel,
      verifiedBy: Number(r.verified_by),
      verifiedAt: Number(r.verified_at),
      verifiedAtText: r.verified_at ? new Date(Number(r.verified_at)).toLocaleString('zh-CN') : '',
    })),
  };
}

module.exports = { listVouchers };
