/**
 * 环境与开关配置
 *
 * 三种环境切换只改这里：
 *   本地联调  → BASE_URL = 'http://127.0.0.1:3000/miniapp/v1'（开发者工具需勾「不校验合法域名」）
 *   测试环境  → 换成测试域名（HTTPS）
 *   生产环境  → 换成生产域名（HTTPS + 后台配置 request 合法域名）
 */
const ENV = 'local'; // local | staging | prod

const ENDPOINTS = {
  local: 'http://127.0.0.1:3000/miniapp/v1',
  staging: 'https://api-test.lbz-chuanchuan.cn/miniapp/v1',
  prod: 'https://api.lbz-chuanchuan.cn/miniapp/v1',
};

module.exports = {
  ENV,
  /** 后端网关地址 */
  BASE_URL: ENDPOINTS[ENV] || ENDPOINTS.local,

  /** true = 走本地内置菜单/订单数据（无后端时演示用）；接后端后必须为 false */
  USE_MOCK: false,

  /**
   * true = 支付走「模拟收银台」（本地弹窗）
   * false = 走服务端 prepay + wx.requestPayment
   * 说明：服务端 PAY_MODE=mock 时 prepay 会返回 mock:true，客户端据此自动走模拟结算，
   *      所以这里保持 false，由服务端决定行为，避免两端开关不一致导致的对不上。
   */
  MOCK_PAY: false,

  /** 客户端版本，上报与灰度用 */
  VERSION: '1.0.0',

  /** 网络 */
  TIMEOUT: 12000,
  /** 幂等请求失败自动重试次数（仅 GET 或显式 idempotent 的请求） */
  RETRY: 1,

  /** 订阅消息模板 ID（在小程序后台「订阅消息」申请后填入） */
  TMPL: {
    ORDER_PAID: 'REPLACE_WITH_TMPL_ID_ORDER_PAID',
    ORDER_READY: 'REPLACE_WITH_TMPL_ID_ORDER_READY',
  },

  /** 客户电话 */
  SERVICE_PHONE: '01088886666',
};
