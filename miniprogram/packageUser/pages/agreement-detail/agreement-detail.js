/**
 * 协议详情（富文本长文）
 * 入参 code：invoice-notice | license-publicity | privacy-policy | user-agreement
 * 正文不缓存：运营在后台改了协议，用户下一次进入就应该是新版本。
 */
const chain = require('../../../services/chain');
const content = require('../../../services/content');
const { formatTime } = require('../../../utils/util');
const { toastError } = require('../../../utils/request');

Page({
  data: {
    themeStyle: '',
    code: '',
    ag: null,
    loading: true,
    timeText: '',
  },

  onLoad(query) {
    this.setData({ code: (query && query.code) || '' });
    chain.applyTheme(this);
    this.fetch();
  },

  fetch() {
    if (!this.data.code) {
      this.setData({ loading: false });
      return Promise.resolve();
    }
    this.setData({ loading: true });
    return content
      .getAgreement(this.data.code)
      .then((ag) => {
        if (ag && ag.title) wx.setNavigationBarTitle({ title: ag.title });
        this.setData({
          ag: ag || null,
          timeText: ag && ag.updatedAt ? formatTime(ag.updatedAt, true) : '',
        });
      })
      .catch((e) => toastError(e, '协议加载失败'))
      .then(() => this.setData({ loading: false }));
  },

  onShareAppMessage() {
    const ag = this.data.ag || {};
    return {
      title: (ag.title || '协议') + ' · 老北京麻辣串串香',
      path: '/packageUser/pages/agreement-detail/agreement-detail?code=' + this.data.code,
    };
  },
});
