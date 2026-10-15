const chain = require('../../../services/chain');
const userService = require('../../../services/user');
const { toast, confirm } = require('../../../utils/util');
const { toastError } = require('../../../utils/request');

Page({
  data: {
    themeStyle: '',
    list: [],
    loading: true,
  },

  onShow() {
    chain.applyTheme(this);
    this.fetch();
  },

  onPullDownRefresh() {
    this.fetch().then(() => wx.stopPullDownRefresh());
  },

  fetch() {
    return userService
      .listAddress()
      .then((list) => this.setData({ list: list || [], loading: false }))
      .catch((e) => {
        this.setData({ loading: false });
        toastError(e, '地址加载失败');
      });
  },

  onAdd() {
    wx.navigateTo({ url: '/packageUser/pages/address-edit/address-edit' });
  },

  onEdit(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/packageUser/pages/address-edit/address-edit?id=' + id });
  },

  onSetDefault(e) {
    const { id, default: isDefault } = e.currentTarget.dataset;
    if (isDefault) return;
    userService
      .setDefaultAddress(id)
      .then(() => {
        toast('已设为默认', 'success');
        this.fetch();
      })
      .catch((err) => toastError(err));
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.list.find((x) => String(x.id) === String(id));
    confirm('删除「' + ((item && item.name) || '') + ' ' + ((item && item.regionText) || '') + '」这个地址？', '删除地址')
      .then((ok) => {
        if (!ok) return;
        return userService
          .deleteAddress(id)
          .then(() => {
            toast('已删除', 'success');
            this.fetch();
          })
          .catch((err) => toastError(err));
      });
  },
});
