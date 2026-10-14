/**
 * RBAC 权限模型 + 多门店数据隔离
 *
 * ── 为什么要单独抽一层 ──
 * 连锁品牌的痛点不是「能不能登录」，而是「加盟商 A 绝对不能看到加盟商 B 的营业额」。
 * 所以这里把两件事强绑在一起：
 *   1. 权限点（能不能做这个动作）
 *   2. 数据范围（能在哪些门店做）
 * 任何业务查询都必须同时过这两关，且**范围过滤由本模块统一产出 SQL 片段**，
 * 不允许业务代码自己拼 store_id 条件（那样迟早漏一处就是数据泄露）。
 *
 * ── 角色与范围 ──
 *   BRAND_ADMIN      品牌超管     全部门店、全部权限
 *   REGION_MANAGER   区域经理     按 region 授权的门店
 *   STORE_MANAGER    店长         被授权的门店（直营店长通常 1 家，可多店）
 *   STAFF            店员         被授权的门店，只读订单 + 推进 + 核销
 *   FRANCHISE_OWNER  加盟商       仅自己的加盟店，权限同店长
 */
const { forbidden } = require('./errors');

/* ------------------------------ 权限点 ------------------------------ */
const PERMS = {
  BRAND_WRITE: 'brand:write',
  STORE_READ: 'store:read',
  STORE_WRITE: 'store:write',
  STAFF_READ: 'staff:read',
  STAFF_WRITE: 'staff:write',
  DISH_READ: 'dish:read',
  DISH_WRITE: 'dish:write',
  DISH_STOCK: 'dish:stock',
  ORDER_READ: 'order:read',
  ORDER_ADVANCE: 'order:advance',
  ORDER_CANCEL: 'order:cancel',
  COUPON_READ: 'coupon:read',
  COUPON_WRITE: 'coupon:write',
  COUPON_ISSUE: 'coupon:issue',
  THEME_READ: 'theme:read',
  THEME_WRITE: 'theme:write',
  VOUCHER_VERIFY: 'voucher:verify',
  VOUCHER_READ: 'voucher:read',
  VOUCHER_REFUND: 'voucher:refund',
  STATS_READ: 'stats:read',
  AUDIT_READ: 'audit:read',
};

const READ_ONLY = [PERMS.STORE_READ, PERMS.STAFF_READ, PERMS.DISH_READ, PERMS.ORDER_READ, PERMS.COUPON_READ, PERMS.THEME_READ, PERMS.VOUCHER_READ, PERMS.STATS_READ];

const ROLES = {
  BRAND_ADMIN: {
    key: 'BRAND_ADMIN',
    name: '品牌超管',
    allStores: true,
    perms: ['*'],
  },
  REGION_MANAGER: {
    key: 'REGION_MANAGER',
    name: '区域经理',
    allStores: false, // 按 region 解析门店
    perms: READ_ONLY.concat([
      PERMS.DISH_STOCK,
      PERMS.ORDER_ADVANCE,
      PERMS.ORDER_CANCEL,
      PERMS.COUPON_WRITE,
      PERMS.COUPON_ISSUE,
      PERMS.THEME_READ,
      PERMS.THEME_WRITE,
      PERMS.VOUCHER_VERIFY,
      PERMS.AUDIT_READ,
    ]),
  },
  STORE_MANAGER: {
    key: 'STORE_MANAGER',
    name: '店长',
    allStores: false,
    perms: READ_ONLY.concat([
      PERMS.DISH_STOCK,
      PERMS.ORDER_ADVANCE,
      PERMS.ORDER_CANCEL,
      PERMS.VOUCHER_VERIFY,
    ]),
  },
  STAFF: {
    key: 'STAFF',
    name: '店员',
    allStores: false,
    perms: [PERMS.STORE_READ, PERMS.DISH_READ, PERMS.ORDER_READ, PERMS.ORDER_ADVANCE, PERMS.VOUCHER_VERIFY],
  },
  FRANCHISE_OWNER: {
    key: 'FRANCHISE_OWNER',
    name: '加盟商',
    allStores: false,
    perms: READ_ONLY.concat([
      PERMS.DISH_STOCK,
      PERMS.ORDER_ADVANCE,
      PERMS.ORDER_CANCEL,
      PERMS.VOUCHER_VERIFY,
    ]),
  },
};

function roleMeta(role) {
  return ROLES[role] || null;
}

function hasPerm(role, perm) {
  const meta = ROLES[role];
  if (!meta) return false;
  if (meta.perms.indexOf('*') > -1) return true;
  return meta.perms.indexOf(perm) > -1;
}

/**
 * 解析员工的数据范围
 * @returns {{brandId:string, role:string, region:string, allStores:boolean, storeIds:string[]}}
 */
function scopeOf(staff, storeIds) {
  return {
    brandId: staff.brand_id,
    role: staff.role,
    region: staff.region || '',
    allStores: !!staff.all_stores,
    storeIds: staff.all_stores ? null : (storeIds || []),
  };
}

/** 权限断言 */
function assertPerm(ctx, perm) {
  const scope = ctx.scope;
  if (!scope) throw forbidden('未登录');
  if (!hasPerm(scope.role, perm)) {
    throw forbidden(`当前角色（${(ROLES[scope.role] || {}).name || scope.role}）无「${perm}」权限`);
  }
}

/** 门店是否在授权范围内 */
function inScope(scope, storeId) {
  if (!scope) return false;
  if (scope.allStores) return true;
  return (scope.storeIds || []).indexOf(storeId) > -1;
}

/** 越权断言：操作指定门店前必须过这一关 */
function assertStore(ctx, storeId) {
  if (!inScope(ctx.scope, storeId)) {
    // 统一文案，不泄露「该门店存在但你没权限」这类信息
    throw forbidden('无权操作该门店');
  }
}

/**
 * 产出 SQL 范围过滤片段
 * 业务代码**必须**使用它，不要自己拼 store_id 条件
 * @param {object} ctx
 * @param {string} column 例如 'o.store_id'
 * @returns {{sql:string, params:any[]}|{sql:string, params:any[], empty:boolean}}
 */
function storeFilter(ctx, column) {
  const scope = ctx.scope;
  const col = column || 'store_id';
  if (!scope) return { sql: ' AND 1=0 ', params: [], empty: true };
  if (scope.allStores) return { sql: '', params: [], empty: false };
  const ids = scope.storeIds || [];
  if (!ids.length) return { sql: ' AND 1=0 ', params: [], empty: true };
  return { sql: ` AND ${col} IN (${ids.map(() => '?').join(',')}) `, params: ids, empty: false };
}

/** 合并范围过滤到已有 where 条件（带 AND 前缀，直接拼接即可） */
function applyScope(where, params, ctx, column) {
  const f = storeFilter(ctx, column);
  return { where: where + f.sql, params: params.concat(f.params), empty: f.empty };
}

/** 角色清单（管理端「新增员工」下拉用） */
function roleOptions() {
  return Object.keys(ROLES).map((k) => ({ key: k, name: ROLES[k].name }));
}

module.exports = {
  PERMS,
  ROLES,
  roleMeta,
  roleOptions,
  hasPerm,
  scopeOf,
  assertPerm,
  assertStore,
  inScope,
  storeFilter,
  applyScope,
};
