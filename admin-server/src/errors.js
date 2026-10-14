/**
 * 统一错误码与业务异常
 * 客户端只认 message（直接 toast），code 用于埋点与排障
 */
class AppError extends Error {
  constructor(code, message, httpStatus, detail) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus || 200; // 业务错误一律 200 + code，避免被网关/客户端当网络错误重试
    this.detail = detail;
    this.expose = true;
  }
}

/** 业务校验失败（参数、状态） */
const bizError = (code, message, detail) => new AppError(code, message, 200, detail);
/** 鉴权失败 → 401，客户端会静默重登并重放 */
const unauthorized = (message) => new AppError(40100, message || '登录态已失效', 401);
/** 越权/禁止 */
const forbidden = (message) => new AppError(40300, message || '无权访问', 403);
/** 资源不存在 */
const notFound = (message) => new AppError(40400, message || '资源不存在', 404);
/** 触发限流 */
const tooMany = (message) => new AppError(42900, message || '操作过于频繁，请稍后再试', 429);
/** 服务不可用（过载/依赖挂掉） */
const unavailable = (message, detail) => new AppError(50300, message || '服务繁忙，请稍后重试', 503, detail);

/** 错误码表（写文档/排障用） */
const CODES = {
  OK: 0,
  PARAM_INVALID: 40001,
  AUTH_FAILED: 40100,
  FORBIDDEN: 40300,
  NOT_FOUND: 40400,
  STATE_CONFLICT: 40901,
  ORDER_DUPLICATED: 40902,
  STOCK_NOT_ENOUGH: 42001,
  COUPON_UNAVAILABLE: 42002,
  AMOUNT_EXCEEDED: 42003,
  RATE_LIMITED: 42900,
  SERVER_ERROR: 50000,
  UPSTREAM_ERROR: 50200,
  UNAVAILABLE: 50300,
};

module.exports = { AppError, bizError, unauthorized, forbidden, notFound, tooMany, unavailable, CODES };
