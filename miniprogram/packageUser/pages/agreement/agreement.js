/**
 * 协议及政策列表
 * 列表项与「我的 → 关于我们」里的协议入口共用一份服务端配置（/agreements）。
 */
const chain = require('../../../services/chain');
const content = require('../../../services/content');
const config = require('../../../utils/config');
const { formatTime } = require('../../../utils/util');
const { toastError } = require('../../../utils/request');

/* 协议 code → 图标（服务端不存图标，避免运营改文案时把图标也改坏） */
const ICONS = {
  'invoice-notice': '🧾',
  'license-publicity': '📜',
  'privacy-policy': '🔒',
  'user-agreement': '📘',
};

Page({
  data: {
    themeStyle: '',
    list: [],
    loading: true,
    version: config.VERSION,
  },

  onShow() {
    chain.applyTheme(this);
    this.fetch();
  },

  onPullDownRefresh() {
    this.fetch().then(() => wx.stopPullDownRefresh());
  },

  fetch() {
    this.setData({ loading: true });
    return content
      .listAgreements()
      .then((list) =>
        this.setData({
          list: (list || []).map((a) =>
            Object.assign({}, a, {
              icon: ICONS[a.code] || '📄',
              timeText: formatTime(a.updatedAt, true),
            })
          ),
        })
      )
      .catch((e) => toastError(e, '协议加载失败'))
      .then(() => this.setData({ loading: false }));
  },

  goDetail(e) {
    wx.navigateTo({
      url: '/packageUser/pages/agreement-detail/agreement-detail?code=' + e.currentTarget.dataset.code,
    });
  },
});
