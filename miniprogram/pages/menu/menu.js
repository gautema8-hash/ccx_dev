const menuService = require('../../services/menu');
const cart = require('../../utils/cart');
const chain = require('../../services/chain');
const { throttle } = require('../../utils/util');

/** scroll 事件 100ms 节流：分类反向高亮不需要 60fps */
const handleDishScroll = throttle(function (e) {
  const scrollTop = e.detail.scrollTop;
  if (this.lockSync) return;
  const tops = this.sectionTops || [];
  if (!tops.length) return;
  let active = tops[0].id;
  for (let i = 0; i < tops.length; i++) {
    if (scrollTop + 6 >= tops[i].top) active = tops[i].id;
  }
  if (active !== this.data.activeCat) {
    this.setData({ activeCat: active, catScrollInto: 'cat-' + active });
  }
}, 100);

Page({
  data: {
    loading: true,
    menu: null,
    shop: null,
    categories: [],
    soups: [],
    dips: [],
    spicyOptions: [],
    totalDishes: 0,

    /** 左侧高亮分类 / 双向联动的 scroll-into-view 目标 */
    activeCat: '',
    catScrollInto: '',
    dishScrollInto: '',

    /** dishId -> 已选数量；catId -> 已选数量 */
    countMap: {},
    catCount: {},

    /** 底部购物车条用的汇总 */
    cart: { count: 0, kinds: 0, totalText: '0.00', soupFeeText: '0.00', soupFee: 0 },

    diningType: 'dinein',
    tableNo: '',
    tables: [],
    tableIndex: 0,

    /** 搜索 */
    keyword: '',
    viewCategories: [],
    searchCount: 0,

    /** 连锁：当前门店 + 主题 */
    storeId: '',
    storeType: 'DIRECT',
    distanceText: '',
    themeStyle: '',
    themeBadge: '',
    themeBannerText: '',
    themeBannerSub: '',

    /** 加菜上下文提示 */
    addDishTip: '',
    parentOrderId: '',

    skuShow: false,
    skuDish: null,
    skuSpicy: '',
    skuCount: 1,
  },

  onLoad() {
    /** 索引表：避免把整个菜品对象塞进 dataset */
    this.dishMap = {};
    this.dishCategory = {};
    /** 各分类区块在滚动内容中的 top 偏移，用于反向高亮 */
    this.sectionTops = [];
    /** 程序化滚动期间关闭反向高亮，避免「抖动」 */
    this.lockSync = false;
    /**
     * tab 页不会被 unload，隐藏时如果还跟着购物车刷新 setData，
     * 就是纯粹浪费一次跨线程序列化 —— 用可见性开关挡掉，回到页面时 onShow 补一次。
     */
    this.visible = false;

    this.unsubscribe = cart.subscribe(() => this.refreshCart());
    this.loadMenu();
  },

  onReady() {
    this.measureSections();
  },

  onShow() {
    this.visible = true;
    chain.applyTheme(this);
    this.syncThemeBanner();
    this.syncStore();
    this.readAddDishContext();
    this.refreshCart();
  },

  /** 门店变了（用户在其他页切换过）→ 清缓存重新拉菜单 */
  syncStore() {
    const store = chain.currentStore();
    const sid = store ? store.id : '';
    this.setData({
      storeId: sid,
      storeType: store ? store.type : 'DIRECT',
      distanceText: store ? store.distanceText || '' : '',
    });
    if (this._loadedStoreId !== undefined && this._loadedStoreId !== sid) {
      menuService.clearCache();
      this.setData({ loading: true }, () => this.loadMenu());
    }
  },

  syncThemeBanner() {
    const t = (getApp().globalData && getApp().globalData.themeTokens) || {};
    this.setData({
      themeBadge: t.badge || '',
      themeBannerText: t.bannerText || '',
      themeBannerSub: t.bannerSub || '',
    });
  },

  goStoreList() {
    wx.navigateTo({ url: '/pages/store-list/store-list' });
  },


  onHide() {
    this.visible = false;
  },

  onUnload() {
    this.visible = false;
    if (this.unsubscribe) this.unsubscribe();
    clearTimeout(this._lockTimer);
    clearTimeout(this._popTimer);
  },

  /* ============================ 数据加载 ============================ */

  loadMenu() {
    menuService
      .getMenu(false, this.data.storeId)
      .then((menu) => {
        const dishMap = {};
        const dishCategory = {};
        menu.categories.forEach((c) =>
          c.dishes.forEach((d) => {
            dishMap[d.id] = d;
            dishCategory[d.id] = c.id;
          })
        );
        this.dishMap = dishMap;
        this.dishCategory = dishCategory;
        this._loadedStoreId = this.data.storeId;

        /* 用当前门店的菜单校正购物车：换店后旧价格/已停售菜品不能留在车里 */
        const rp = cart.reprice(dishMap);
        if (rp.removed > 0) {
          wx.showToast({
            title: rp.removed + ' 款商品在当前门店不可售，已移出购物车',
            icon: 'none',
            duration: 2200,
          });
        } else if (rp.changed > 0) {
          wx.showToast({ title: '价格已按当前门店更新', icon: 'none', duration: 1600 });
        }

        const tables = (menu.shop && menu.shop.tables) || [];
        const state = cart.get();
        // 默认选一个锅底，减少用户决策步骤（可随时更换）
        if (!state.soup && menu.soups.length) cart.setSoup(menu.soups[0]);
        if (state.diningType === 'dinein' && !state.tableNo && tables.length) {
          cart.setTableNo(tables[0]);
        }

        this.setData(
          {
            loading: false,
            menu,
            shop: menu.shop,
            categories: menu.categories,
            soups: menu.soups,
            dips: menu.dips,
            spicyOptions: menu.spicyOptions,
            totalDishes: menu.totalDishes,
            tables,
            tableIndex: Math.max(0, tables.indexOf(cart.get().tableNo)),
            activeCat: menu.categories.length ? menu.categories[0].id : '',
            viewCategories: menu.categories,
          },
          () => {
            this.refreshCart();
            // 等首屏渲染完成再量各分类位置，避免量到骨架屏
            wx.nextTick(() => this.measureSections());
          }
        );
      })
      .catch((err) => {
        console.error('[menu] load fail', err);
        this.setData({ loading: false });
        wx.showToast({ title: '菜单加载失败，请下拉重试', icon: 'none' });
      });
  },

  /** 量出每个分类区块相对滚动内容顶部的偏移 */
  measureSections() {
    const cats = this.data.keyword ? [] : this.data.categories || [];
    if (!cats.length) return;
    const query = wx.createSelectorQuery();
    query.select('.dishes').boundingClientRect();
    cats.forEach((c) => query.select('#sec-' + c.id).boundingClientRect());
    query.exec((res) => {
      const listRect = res[0];
      if (!listRect) return;
      this.sectionTops = cats
        .map((c, i) => ({
          id: c.id,
          top: res[i + 1] ? res[i + 1].top - listRect.top : 0,
        }))
        .filter((x) => x.top >= 0);
    });
  },

  /* ============================ 购物车联动 ============================ */

  refreshCart() {
    // 页面不可见时不做 setData（tab 页常驻内存，隐藏期间购物车变化由 onShow 统一补）
    if (!this.visible) return;
    const items = cart.get().items;
    const countMap = {};
    const catCount = {};
    items.forEach((i) => {
      countMap[i.dishId] = (countMap[i.dishId] || 0) + i.count;
      const cid = this.dishCategory[i.dishId];
      if (cid) catCount[cid] = (catCount[cid] || 0) + i.count;
    });
    const state = cart.get();
    this.setData({
      countMap,
      catCount,
      cart: cart.getSummary(),
      diningType: state.diningType,
      tableNo: state.tableNo,
      tableIndex: Math.max(0, (this.data.tables || []).indexOf(state.tableNo)),
    });
  },

  /* ============================ 搜索 ============================ */

  onSearchInput(e) {
    const keyword = e.detail.value || '';
    this.applySearch(keyword);
  },

  onClearSearch() {
    this.applySearch('');
  },

  /**
   * 本地搜索：菜单在内存里，过滤是同步的，无需防抖也无需网络请求
   * 搜索结果用一个虚拟分类承载，模板层不用写两套结构
   */
  applySearch(keyword) {
    const kw = String(keyword || '');
    if (!kw.trim()) {
      this.setData({ keyword: '', viewCategories: this.data.categories, searchCount: 0 }, () =>
        wx.nextTick(() => this.measureSections())
      );
      return;
    }
    const hits = menuService.searchMenu(this.data.menu || { categories: this.data.categories }, kw) || [];
    this.setData({
      keyword: kw,
      viewCategories: hits.length
        ? [{ id: '__search', name: '搜索结果', emoji: '🔍', dishes: hits }]
        : [],
      searchCount: hits.length,
    });
  },

  /* ============================ 加菜上下文 ============================ */

  /** 从订单详情点「加菜」跳过来时，带出桌号与就餐方式并给出提示 */
  readAddDishContext() {
    const app = getApp();
    const ctx = app.globalData.addDishFrom;
    if (!ctx) {
      if (this.data.addDishTip) this.setData({ addDishTip: '', parentOrderId: '' });
      return;
    }
    cart.setDiningType(ctx.diningType === 'takeout' ? 'takeout' : 'dinein');
    if (ctx.tableNo) cart.setTableNo(ctx.tableNo);
    this.setData({ addDishTip: ctx.tableLabel || '本单加菜', parentOrderId: ctx.parentOrderId || '' });
    this.refreshCart();
  },

  onCancelAddDish() {
    const app = getApp();
    app.globalData.addDishFrom = null;
    this.setData({ addDishTip: '', parentOrderId: '' });
    wx.showToast({ title: '已取消加菜', icon: 'none' });
  },

  /* ============================ 分类联动 ============================ */

  onCatTap(e) {
    const id = e.currentTarget.dataset.id;
    this.lockSync = true;
    clearTimeout(this._lockTimer);
    this._lockTimer = setTimeout(() => {
      this.lockSync = false;
      // 置空后下次点击同一分类也能重新触发 scroll-into-view
      this.setData({ dishScrollInto: '' });
    }, 480);
    this.setData({
      activeCat: id,
      catScrollInto: 'cat-' + id,
      dishScrollInto: 'sec-' + id,
    });
  },

  onDishScroll: handleDishScroll,

  /* ============================ 加购 ============================ */

  onAddDish(e) {
    const id = e.currentTarget.dataset.id;
    const dish = this.dishMap[id];
    if (!dish) return;
    if (dish.soldOut) {
      wx.showToast({ title: '「' + dish.name + '」已售罄', icon: 'none' });
      return;
    }
    if (dish.spicy) {
      this.setData({
        skuShow: true,
        skuDish: dish,
        skuSpicy: cart.getLastSpec(dish.id),
        skuCount: 1,
      });
      return;
    }
    cart.add(dish, null, 1);
    this.feedback();
  },

  onSkuConfirm(e) {
    const { dishId, spicyId, spicyName, count } = e.detail;
    const dish = this.dishMap[dishId];
    if (!dish) return;
    cart.add(dish, { spicyId, spicyName }, count);
    this.setData({ skuShow: false });
    this.feedback();
    wx.showToast({
      title: `${dish.name} · ${spicyName} ×${count}`,
      icon: 'none',
      duration: 1200,
    });
  },

  onSkuClose() {
    this.setData({ skuShow: false });
  },

  /** 无规格菜品的直接加减 */
  onDishStepperChange(e) {
    const id = e.currentTarget.dataset.id;
    const dish = this.dishMap[id];
    if (!dish) return;
    const next = e.detail.value;
    const old = cart.getDishCount(id);
    const delta = next - old;
    if (delta > 0) cart.add(dish, null, delta);
    else if (delta < 0) cart.reduceDish(id, -delta);
    if (delta > 0) this.feedback();
  },

  /**
   * 无规格菜的一键加购（醒目「+」按钮）
   * 与 stepper 的区别：不需要先展示步进器，点一下直接 +1 并给「+1」飘字反馈；
   * 有数量后按钮切换成 stepper，可继续加减。
   */
  onQuickAdd(e) {
    const id = e.currentTarget.dataset.id;
    const dish = this.dishMap[id];
    if (!dish) return;
    if (dish.soldOut) {
      wx.showToast({ title: '「' + dish.name + '」已售罄', icon: 'none' });
      return;
    }
    /* 与 stepper 的 max=dish.stock 同一套约束：加到库存上限给出明确提示 */
    if (cart.getDishCount(id) >= dish.stock) {
      wx.showToast({ title: '已达库存上限', icon: 'none' });
      return;
    }
    cart.add(dish, null, 1);
    this.feedback();
    this.popPlus(id);
  },

  /** 「+1」飘字：加购时在按钮上方叠一个上浮渐隐的提示（0.7s 自动消失） */
  popPlus(id) {
    if (this._popTimer) clearTimeout(this._popTimer);
    this.setData({ popDishId: id });
    this._popTimer = setTimeout(() => {
      this._popTimer = null;
      this.setData({ popDishId: '' });
    }, 700);
  },

  feedback() {
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light', fail: () => {} });
  },

  /* ============================ 就餐方式 ============================ */

  onDiningTap(e) {
    const v = e.currentTarget.dataset.v;
    if (v === this.data.diningType) return;
    cart.setDiningType(v);
    if (v === 'dinein' && !cart.get().tableNo) {
      const tables = this.data.tables || [];
      if (tables.length) cart.setTableNo(tables[0]);
    }
    this.refreshCart();
  },

  onTableChange(e) {
    const idx = Number(e.detail.value);
    const tables = this.data.tables || [];
    cart.setTableNo(tables[idx] || '');
    this.setData({ tableIndex: idx, tableNo: tables[idx] || '' });
  },

  /* ============================ 跳转 ============================ */

  goCart() {
    if (!this.data.cart.count) {
      wx.showToast({ title: '还没选串，点「+」开始吧', icon: 'none' });
      return;
    }
    wx.switchTab({ url: '/pages/cart/cart' });
  },

  onShareAppMessage() {
    return {
      title: '老北京麻辣串串香 · 现串现涮，桌边扫码即点',
      path: '/pages/menu/menu',
    };
  },
});
