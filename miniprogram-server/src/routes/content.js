/**
 * 内容域：协议及政策 + 加盟咨询配置
 *
 * 这两个都是「纯读配置 + 后台可维护」，因此：
 *   · 小程序端只读（可选登录），内容变更由管理端走内部接口
 *   · 返回体直接给渲染字段，客户端不再二次拼装
 */
const db = require('../db');
const { notFound } = require('../errors');

/* ============================================================ 协议及政策 ============================================================ */

async function listAgreements(ctx) {
  const rows = await db.query(
    'SELECT code, title, summary, version, sort, updated_at FROM mp_agreement WHERE status = 1 ORDER BY sort ASC, id ASC'
  );
  return ctx.ok({
    list: rows.map((r) => ({
      code: r.code,
      title: r.title,
      summary: r.summary,
      version: r.version,
      updatedAt: Number(r.updated_at),
    })),
  });
}

async function getAgreement(ctx) {
  const code = String(ctx.params.code || '').slice(0, 32);
  const row = await db.queryOne('SELECT * FROM mp_agreement WHERE code = ? AND status = 1', [code]);
  if (!row) throw notFound('协议不存在或已下线');
  return ctx.ok({
    code: row.code,
    title: row.title,
    summary: row.summary,
    contentHtml: row.content_html || '',
    version: row.version,
    updatedAt: Number(row.updated_at),
  });
}

/* ============================================================ 加盟咨询 ============================================================ */

function franchiseDto(row) {
  let highlights = [];
  try {
    highlights = row.highlights ? JSON.parse(row.highlights) : [];
  } catch (e) {
    highlights = [];
  }
  return {
    title: row.title,
    subtitle: row.subtitle,
    highlights: Array.isArray(highlights) ? highlights.slice(0, 8) : [],
    posterUrl: row.poster_url || '',
    qrUrl: row.qr_url || '',
    qrTip: row.qr_tip || '',
    consultPhone: row.consult_phone || '',
    wecomId: row.wecom_id || '',
    updatedAt: Number(row.updated_at),
  };
}

async function getFranchise(ctx) {
  const brandId = String((ctx.query && ctx.query.brandId) || 'brand_lbz').slice(0, 32);
  const row = await db.queryOne('SELECT * FROM mp_franchise_config WHERE brand_id = ? ORDER BY updated_at DESC LIMIT 1', [brandId]);
  if (!row) throw notFound('加盟配置尚未初始化');
  return ctx.ok(franchiseDto(row));
}

module.exports = { listAgreements, getAgreement, getFranchise, franchiseDto };
