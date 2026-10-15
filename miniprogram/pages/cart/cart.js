const cart = require('../../utils/cart');
const menuService = require('../../services/menu');
const { confirm, toast, fen2yuan } = require('../../utils/util');

Page({
  data: {
    themeStyle: '',
    items: [],
    soups: [],
    dips: [],
    dipChecked: {},
    soupId: '',
    soupName: '未选择',
    tables: [],
    tableIndex: 0,
    diningType: 'dinein',
    tableNo: '',
    peopleCount: 2,
    remark: '',
    count: 0,
    summary: { goodsText: '0.00', soupFeeText: '0.00', packFeeText: '0.00', totalText: '0.00', canSubmit: false },
    blockReason: '',
  },

  onLoad() {
    /** 用户是否已经动过备注框：动过之后以页面本地值为准，避免刷新时把用户刚清空的内容又填回去 */
    this._remarkTouched = false;
    /** 可见性开关：隐藏时跳过 setData，onShow 时补一次（tab 页常驻内存） */
    this.visible = false;
    this.unsubscribe = cart.subscribe(() => this.refresh());
    this.loadOptions();
  },

  onShow() {
    require('../../services/chain').applyTheme(this);
    this.visible = true;
    this.refresh();
  },

  onHide() {
    this.visible = false;
  },

  onUnload() {
    this.visible = false;
    if (this.unsubscribe) this.unsubscribe();
    this.commitRemark();
  },

  /* ------------------------- 数据 ------------------------- */

  loadOptions() {
    menuService
      .getMenu(false, (require('../../services/chain').currentStore() || {}).id || '')
      .then((menu) => {
        this.setData(
          {
            soups: menu.soups,
            dips: menu.dips,
            tables: (menu.shop && menu.shop.tables) || [],
          },
          () => this.refresh()
        );
      })
      .catch(() => {});
  },

  refresh() {
    if (!this.visible) return;
    const state = cart.get();
    const items = state.items.map((i) =>
      Object.assign({}, i, { priceText: fen2yuan(i.price) })
    );
    const dipChecked = {};
    state.dips.forEach((d) => {
      dipChecked[d.id] = true;
    });
    const summary = cart.getSummary();

    this.setData({
      items,
      dipChecked,
      soupId: state.soup ? state.soup.id : '',
      soupName: state.soup ? state.soup.name : '未选择',
      diningType: state.diningType,
      tableNo: state.tableNo,
      tableIndex: Math.max(0, (this.data.tables || []).indexOf(state.tableNo)),
      peopleCount: state.peopleCount,
      remark: this._remarkTouched ? this.data.remark : state.remark,
      count: summary.count,
      summary,
      blockReason: this.blockReason(summary, state),
    });
  },

  /** 未满足下单条件时告诉用户「差什么」，而不是灰掉按钮不解释 */
  blockReason(summary, state) {
    if (!state.items.length) return '请先选择菜品';
    if (!state.soup) return '请选择锅底';
    if (state.diningType === 'dinein' && !state.tableNo) return '请选择桌号';
    return '';
  },

  /* ------------------------- 就餐信息 ------------------------- */

  onDiningTap(e) {
    const v = e.currentTarget.dataset.v;
    if (v === this.data.diningType) return;
    cart.setDiningType(v);
    if (v === 'dinein' && !cart.get().tableNo && this.data.tables.length) {
      cart.setTableNo(this.data.tables[0]);
    }
    this.refresh();
  },

  onTableChange(e) {
    const idx = Number(e.detail.value);
    cart.setTableNo(this.data.tables[idx] || '');
    this.setData({ tableIndex: idx, tableNo: this.data.tables[idx] || '' });
  },

  onPeopleChange(e) {
    cart.setPeopleCount(e.detail.value);
    this.setData({ peopleCount: e.detail.value });
  },

  /* ------------------------- 锅底 / 蘸料 ------------------------- */

  onPickSoup(e) {
    const id = e.currentTarget.dataset.id;
    const soup = this.data.soups.find((s) => s.id === id);
    if (!soup) return;
    cart.setSoup(soup);
  },

  onToggleDip(e) {
    const { id, name } = e.currentTarget.dataset;
    cart.toggleDip({ id, name });
  },

  /* ------------------------- 明细 ------------------------- */

  onItemCountChange(e) {
    const key = e.currentTarget.dataset.key;
    cart.setCount(key, e.detail.value);
  },

  onLongPressItem(e) {
    const key = e.currentTarget.dataset.key;
    const item = this.data.items.find((i) => i.key === key);
    if (!item) return;
    confirm(`确定删除「${item.name}」吗？`).then((ok) => {
      if (ok) cart.remove(key);
    });
  },

  onClear() {
    confirm('确定清空购物车全部菜品吗？').then((ok) => {
      if (ok) {
        cart.clear(false);
        toast('已清空');
      }
    });
  },

  /* ------------------------- 备注 ------------------------- */

  onRemarkInput(e) {
    this._remarkTouched = true;
    this.setData({ remark: e.detail.value });
  },

  onRemarkBlur() {
    this.commitRemark();
  },

  commitRemark() {
    if (this.data.remark !== cart.get().remark) cart.setRemark(this.data.remark);
    this._remarkTouched = false;
  },

  /* ------------------------- 跳转 ------------------------- */

  goConfirm() {
    if (!this.data.summary.canSubmit) {
      wx.showToast({ title: this.data.blockReason || '请完善订单信息', icon: 'none' });
      return;
    }
    this.commitRemark();
    wx.navigateTo({ url: '/pages/confirm/confirm' });
  },

  goMenu() {
    wx.redirectTo({ url: '/pages/menu/menu' });
  },

  onShareAppMessage() {
    return { title: '老北京麻辣串串香 · 现串现涮', path: '/pages/menu/menu' };
  },
});
