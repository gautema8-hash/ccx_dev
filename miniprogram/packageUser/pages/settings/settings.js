const chain = require('../../../services/chain');
const cart = require('../../../utils/cart');
const auth = require('../../../utils/auth');
const userService = require('../../../services/user');
const orderService = require('../../../services/order');
const { toast, confirm } = require('../../../utils/util');
const { toastError } = require('../../../utils/request');

Page({
  data: {
    themeStyle: '',
    user: {},
    ongoingCount: 0,
  },

  onShow() {
    chain.applyTheme(this);
    const user = auth.localUser() || getApp().globalData.userInfo || {};
    this.setData({ user });
    orderService
      .listOrders('all')
      .then((orders) => this.setData({ ongoingCount: orders.filter((o) => orderService.isOngoing(o.status)).length }))
      .catch(() => {});
  },

  /** 切换账号：退出当前登录态并重新静默登录（换微信号时即切换到新账号） */
  onSwitch() {
    confirm('将退出当前账号并重新登录，是否继续？', '切换账号').then((ok) => {
      if (!ok) return;
      wx.showLoading({ title: '切换中', mask: true });
      auth.logout();
      clearLocal();
      auth
        .silentLogin(true)
        .then(() => {
          wx.hideLoading();
          toast('已切换账号', 'success');
          const user = auth.localUser() || {};
          this.setData({ user });
        })
        .catch(() => {
          wx.hideLoading();
          toast('切换失败，请重新进入小程序');
        });
    });
  },

  onLogout() {
    confirm('退出后需要重新登录才能下单，确定退出？', '退出登录').then((ok) => {
      if (!ok) return;
      auth.logout();
      clearLocal();
      toast('已退出登录', 'success');
      setTimeout(() => wx.switchTab({ url: '/pages/menu/menu' }), 600);
    });
  },

  /**
   * 注销账号：双重确认（第二次要求输入「注销」二字）
   * 单次弹窗太容易误触，而注销是不可逆操作，必须让人真正停下来读一遍
   */
  onCancel() {
    if (this.data.ongoingCount > 0) {
      wx.showModal({
        title: '暂时无法注销',
        content: '你有 ' + this.data.ongoingCount + ' 个进行中的订单，请完成或取消后再申请注销。',
        showCancel: false,
        confirmColor: '#C62828',
      });
      return;
    }
    confirm('注销后账号不可恢复：昵称/头像/手机号将被删除，历史订单与优惠券作废。确定继续？', '注销账号（第一步）').then((ok) => {
      if (!ok) return;
      wx.showModal({
        title: '最终确认',
        editable: true,
        placeholderText: '请输入「注销」两个字以确认',
        confirmColor: '#C62828',
        success: (r) => {
          if (!r.confirm) return;
          if (String(r.content || '').trim() !== '注销') return toast('输入不正确，已取消注销');
          this.doCancel();
        },
      });
    });
  },

  doCancel() {
    wx.showLoading({ title: '注销中', mask: true });
    userService
      .cancelAccount('用户主动注销')
      .then(() => {
        wx.hideLoading();
        auth.logout();
        clearLocal();
        wx.showModal({
          title: '注销成功',
          content: '你的账号已注销。感谢你曾经的每一次撸串，期待下次重逢 🌶️',
          showCancel: false,
          confirmColor: '#C62828',
          success: () => {
            wx.reLaunch({ url: '/pages/menu/menu' });
          },
        });
      })
      .catch((e) => {
        wx.hideLoading();
        toastError(e, '注销失败，请稍后重试');
      });
  },
});

/** 清理本地个人数据（购物车 / 订单缓存 / 登录态） */
function clearLocal() {
  cart.clearAll();
  wx.removeStorageSync('lbz_orders_v1');
  wx.removeStorageSync('lbz_pickup_seq');
  wx.removeStorageSync('lbz_invoice_v1');
  wx.removeStorageSync('lbz_address_v1');
  getApp().globalData.menuCache = null;
  getApp().syncCartBadge();
}
