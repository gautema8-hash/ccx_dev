/**
 * 主题系统（品牌活动日 / 节假日 / 会员日 …）
 *
 * ── 解析优先级 ──
 *   门店级主题（store_id 非空）  >  品牌级主题（store_id 为空）
 *   同一层级内：在生效时间窗内、status=1 的，取 priority 最大者
 *   都没有命中 → 返回默认主题（Normal），小程序永远拿得到一份可用令牌
 *
 * ── 为什么令牌用「覆盖式」而不是「整套替换」──
 *   整套替换意味着每次新增主题都要把全部令牌抄一遍，改一个默认色要改 N 处。
 *   这里只存差异，解析时 merge 到默认令牌上，主题多也不会失控。
 */
const db = require('./db');
const logger = require('./logger');
const { bizError, notFound, CODES } = require('./errors');

/** 默认主题令牌（与小程序 app.wxss 的 CSS 变量一一对应） */
const DEFAULT_TOKENS = {
  primary: '#C62828',
  primaryDark: '#9E1B1B',
  primaryWeak: '#FDECEC',
  accent: '#FF8F1F',
  text: '#1F1F1F',
  sub: '#8A8A8E',
  line: '#EDEDF0',
  bg: '#F5F5F7',
  card: '#FFFFFF',
  navBg: '#C62828',
  navText: '#FFFFFF',
  /** 首页顶部横幅文案（活动日/会员日用来挂口号） */
  bannerText: '',
  bannerSub: '',
  /** 悬浮购物车条底色，节日主题常会换 */
  barBg: '#1F1F1F',
  /** 顶部品牌角标文案，例如「国庆欢乐场」 */
  badge: '',
};

/**
 * 预置主题模板：管理端「一键套用」用，避免运营自己配色调
 * 只写差异项，其余走默认
 */
const PRESETS = {
  NORMAL: {
    name: '标准主题',
    type: 'NORMAL',
    tokens: {},
    description: '日常营业，品牌标准红金配色',
  },
  CAMPAIGN: {
    name: '品牌活动日',
    type: 'CAMPAIGN',
    tokens: { primary: '#D81B60', primaryDark: '#AD1457', primaryWeak: '#FCE4EC', accent: '#FFB300', navBg: '#D81B60', bannerText: '品牌活动日', bannerSub: '全场串串 8.8 折起', badge: '活动进行中' },
    description: '品牌统一活动，玫红+琥珀，适合周年庆/开业季',
  },
  HOLIDAY: {
    name: '国庆节假日',
    type: 'HOLIDAY',
    tokens: { primary: '#C62828', primaryDark: '#8E0000', primaryWeak: '#FFEBEE', accent: '#FFC107', navBg: '#C62828', bannerText: '举国同庆', bannerSub: '节日期间每桌赠酸梅汤一扎', badge: '国庆专场' },
    description: '节庆氛围，正红+金黄',
  },
  MEMBER_DAY: {
    name: '会员日',
    type: 'MEMBER_DAY',
    tokens: { primary: '#2E2A26', primaryDark: '#141210', primaryWeak: '#F2EFEA', accent: '#C9A227', navBg: '#2E2A26', barBg: '#2E2A26', bannerText: '会员日', bannerSub: '会员专享 · 积分双倍', badge: '会员日' },
    description: '高端黑金，每周固定会员日',
  },
};

function mergeTokens(rawTokens) {
  let override = {};
  if (rawTokens) {
    try {
      override = typeof rawTokens === 'string' ? JSON.parse(rawTokens) : rawTokens;
    } catch (e) {
      override = {};
    }
  }
  const out = Object.assign({}, DEFAULT_TOKENS);
  Object.keys(override).forEach((k) => {
    /* 只接受已知令牌，防止把前端 CSS 变量注进来的任意键透传（样式注入面收敛） */
    if (Object.prototype.hasOwnProperty.call(DEFAULT_TOKENS, k)) {
      const v = String(override[k] == null ? '' : override[k]).slice(0, 120);
      /* 颜色/尺寸类的值只允许安全字符，阻断 url() / expression() 之类的注入 */
      if (/^[#(),.%\-\s\w\u4e00-\u9fa5]*$/.test(v)) out[k] = v;
    }
  });
  return out;
}

function themeDTO(t) {
  return {
    id: t.id,
    brandId: t.brand_id,
    storeId: t.store_id,
    scope: t.store_id ? 'STORE' : 'BRAND',
    name: t.name,
    type: t.type,
    description: t.description,
    tokens: mergeTokens(t.tokens_json),
    startAt: Number(t.start_at || 0),
    endAt: Number(t.end_at || 0),
    priority: Number(t.priority || 0),
    status: Number(t.status),
    /** 前端用来显示「立即生效 / 定时生效 / 已过期」 */
    state: (() => {
      const now = Date.now();
      if (Number(t.status) !== 1) return 'DISABLED';
      if (Number(t.start_at) && now < Number(t.start_at)) return 'PENDING';
      if (Number(t.end_at) && now > Number(t.end_at)) return 'EXPIRED';
      return 'ACTIVE';
    })(),
    createdAt: Number(t.created_at || 0),
    updatedAt: Number(t.updated_at || 0),
  };
}

/**
 * 解析当前生效主题
 * @param {string} brandId
 * @param {string} storeId 可为空（小程序没选门店时只看品牌级）
 */
async function resolveTheme(brandId, storeId) {
  const now = Date.now();
  const rows = await db.query(
    `SELECT * FROM mp_theme
     WHERE brand_id = ? AND status = 1
       AND (store_id = ? OR store_id = '')
       AND (start_at = 0 OR start_at <= ?)
       AND (end_at = 0 OR end_at >= ?)
     ORDER BY (store_id = ?) DESC, priority DESC, updated_at DESC
     LIMIT 1`,
    [brandId, storeId || '', now, now, storeId || '']
  );
  if (!rows.length) {
    return {
      id: 'default',
      name: '标准主题',
      type: 'NORMAL',
      scope: 'DEFAULT',
      tokens: mergeTokens(null),
      description: '未配置主题时的默认样式',
    };
  }
  const dto = themeDTO(rows[0]);
  return {
    id: dto.id,
    name: dto.name,
    type: dto.type,
    scope: dto.scope,
    tokens: dto.tokens,
    description: dto.description,
    startAt: dto.startAt,
    endAt: dto.endAt,
  };
}

/* ============================================================ 管理端 */
async function listThemes(scope, q) {
  /* 数据范围：品牌级主题所有人都能看；门店级主题只看授权门店 */
  const params = [scope.brandId];
  let where = 'WHERE brand_id = ?';
  if (!scope.allStores) {
    const ids = scope.storeIds || [];
    if (!ids.length) return [];
    where += ` AND (store_id = '' OR store_id IN (${ids.map(() => '?').join(',')}))`;
    params.push.apply(params, ids);
  }
  if (q && q.status !== undefined && q.status !== '') {
    where += ' AND status = ?';
    params.push(Number(q.status));
  }
  const rows = await db.query(`SELECT * FROM mp_theme ${where} ORDER BY status DESC, priority DESC, updated_at DESC`, params);
  return rows.map(themeDTO);
}

function assertThemeWriteScope(scope, storeId) {
  if (storeId && !scope.allStores) {
    const ids = scope.storeIds || [];
    if (!scope.allStores && ids.indexOf(storeId) === -1) {
      throw bizError(CODES.FORBIDDEN, '无权修改该门店的主题');
    }
  }
}

async function saveTheme(scope, staffId, body) {
  const name = String(body.name || '').trim().slice(0, 64);
  if (!name) throw bizError(CODES.PARAM_INVALID, '请填写主题名称');
  const type = ['NORMAL', 'CAMPAIGN', 'HOLIDAY', 'MEMBER_DAY', 'CUSTOM'].indexOf(body.type) > -1 ? body.type : 'CUSTOM';
  const storeId = String(body.storeId || '').slice(0, 32);
  assertThemeWriteScope(scope, storeId);

  const tokens = mergeTokens(body.tokens);
  const startAt = Math.max(0, Math.trunc(Number(body.startAt) || 0));
  const endAt = Math.max(0, Math.trunc(Number(body.endAt) || 0));
  if (startAt && endAt && endAt < startAt) throw bizError(CODES.PARAM_INVALID, '结束时间不能早于开始时间');

  const now = Date.now();
  if (body.id) {
    const exist = await db.queryOne('SELECT * FROM mp_theme WHERE id = ? AND brand_id = ?', [body.id, scope.brandId]);
    if (!exist) throw notFound('主题不存在');
    await db.execute(
      `UPDATE mp_theme SET store_id=?, name=?, type=?, tokens_json=?, description=?, start_at=?, end_at=?, priority=?, updated_at=?
       WHERE id=? AND brand_id=?`,
      [storeId, name, type, JSON.stringify(tokens), String(body.description || '').slice(0, 250), startAt, endAt, Math.trunc(Number(body.priority) || 0), now, body.id, scope.brandId]
    );
    return { id: body.id, updated: true };
  }

  const id = 'th' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  await db.execute(
    `INSERT INTO mp_theme (id, brand_id, store_id, name, type, tokens_json, description, start_at, end_at, priority, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
    [id, scope.brandId, storeId, name, type, JSON.stringify(tokens), String(body.description || '').slice(0, 250), startAt, endAt, Math.trunc(Number(body.priority) || 0), staffId || 0, now, now]
  );
  logger.info('theme created', { id, name, type, storeId, by: staffId });
  return { id, created: true };
}

/**
 * 一键切换主题
 * 语义：把目标主题置为「当前最高优先级并在生效窗内」，同时把同层级其他主题
 * 的优先级压到目标之下（不删除，方便随后切回来）
 */
async function activateTheme(scope, staffId, id) {
  const theme = await db.queryOne('SELECT * FROM mp_theme WHERE id = ? AND brand_id = ?', [id, scope.brandId]);
  if (!theme) throw notFound('主题不存在');
  assertThemeWriteScope(scope, theme.store_id);

  const now = Date.now();
  await db.tx(async (tx) => {
    /* 同层级（同门店范围）的其它主题降权 */
    await tx.execute(
      `UPDATE mp_theme SET priority = 0, updated_at = ? WHERE brand_id = ? AND store_id = ? AND id <> ?`,
      [now, scope.brandId, theme.store_id, id]
    );
    await tx.execute(
      'UPDATE mp_theme SET status = 1, priority = 1000, start_at = 0, end_at = 0, updated_at = ? WHERE id = ?',
      [now, id]
    );
  });
  logger.info('theme activated', { id, name: theme.name, storeId: theme.store_id, by: staffId });
  return { ok: true, id };
}

/**
 * 上下架主题
 * 注意：权限点（theme:write）之外必须再过一次门店范围校验 ——
 * 区域经理有 theme:write，但他的范围是按 region 解析的，
 * 不校验就会允许「华南区域经理关掉东直门店的活动主题」。
 */
async function toggleTheme(scope, id, status) {
  const theme = await db.queryOne('SELECT * FROM mp_theme WHERE id = ? AND brand_id = ?', [id, scope.brandId]);
  if (!theme) throw notFound('主题不存在');
  assertThemeWriteScope(scope, theme.store_id);
  const r = await db.execute('UPDATE mp_theme SET status = ?, updated_at = ? WHERE id = ? AND brand_id = ?', [
    status ? 1 : 0, Date.now(), id, scope.brandId,
  ]);
  if (r.affectedRows === 0) throw notFound('主题不存在');
  return { ok: true };
}

async function deleteTheme(scope, id) {
  const theme = await db.queryOne('SELECT * FROM mp_theme WHERE id = ? AND brand_id = ?', [id, scope.brandId]);
  if (!theme) throw notFound('主题不存在');
  assertThemeWriteScope(scope, theme.store_id);
  const r = await db.execute('DELETE FROM mp_theme WHERE id = ? AND brand_id = ?', [id, scope.brandId]);
  if (r.affectedRows === 0) throw notFound('主题不存在');
  return { ok: true };
}

module.exports = {
  DEFAULT_TOKENS,
  PRESETS,
  mergeTokens,
  themeDTO,
  resolveTheme,
  listThemes,
  saveTheme,
  activateTheme,
  toggleTheme,
  deleteTheme,
};
