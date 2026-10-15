/**
 * 内容服务：协议及政策 / 加盟咨询
 * 都是「只读配置」，服务端改完小程序端即时生效（不缓存正文，避免用户看到旧协议版本）
 */
const config = require('../utils/config');
const { request } = require('../utils/request');

const MOCK_AGREEMENTS = [
  { code: 'invoice-notice', title: '开票须知', summary: '电子发票开具范围、时限与常见问题', version: 'v1.1', updatedAt: Date.now() },
  { code: 'license-publicity', title: '经营者证照公示', summary: '营业执照、食品经营许可证与食品安全承诺', version: 'v1.0', updatedAt: Date.now() },
  { code: 'privacy-policy', title: '隐私协议', summary: '我们如何收集、使用与保护你的个人信息', version: 'v1.2', updatedAt: Date.now() },
  { code: 'user-agreement', title: '用户协议', summary: '使用本小程序服务前请阅读并同意以下条款', version: 'v1.2', updatedAt: Date.now() },
];

/** 协议列表 */
function listAgreements() {
  if (config.USE_MOCK) return Promise.resolve(MOCK_AGREEMENTS);
  return request({ url: '/agreements', method: 'GET', idempotent: true }).then((d) => d.list || []);
}

/** 协议详情（contentHtml 由 rich-text 渲染） */
function getAgreement(code) {
  if (config.USE_MOCK) {
    const item = MOCK_AGREEMENTS.find((a) => a.code === code) || MOCK_AGREEMENTS[0];
    return Promise.resolve(
      Object.assign({}, item, {
        contentHtml:
          '<h3>' + item.title + '</h3><p>当前处于离线演示模式，正文内容请连接后端后查看。</p>' +
          '<p>示例条款：本协议示例用于演示富文本长文滚动与排版效果，实际内容以服务端配置为准。</p>' +
          '<h3>更多说明</h3><p>可在管理后台「协议及政策」中维护正文（支持 HTML 片段）。</p>',
      })
    );
  }
  return request({ url: '/agreements/' + code, method: 'GET', idempotent: true });
}

/** 加盟咨询配置（海报文案 + 企微二维码） */
function getFranchise() {
  if (config.USE_MOCK) {
    return Promise.resolve({
      title: '老北京麻辣串串香 · 城市合伙人计划',
      subtitle: '现串现涮 · 一口老北京味，开到你的城市',
      highlights: [
        { icon: '🏪', label: '已开门店', value: '5 家' },
        { icon: '💰', label: '单店投资', value: '35-60 万' },
        { icon: '📈', label: '回本周期', value: '约 12-18 个月' },
        { icon: '🤝', label: '合作模式', value: '整店加盟 / 区域代理' },
      ],
      posterUrl: '',
      qrUrl: '',
      qrTip: '长按识别二维码，添加加盟顾问企业微信',
      consultPhone: '400-888-6666',
      wecomId: 'lbz_franchise',
      updatedAt: Date.now(),
    });
  }
  return request({ url: '/franchise', method: 'GET', idempotent: true });
}

module.exports = { listAgreements, getAgreement, getFranchise };
