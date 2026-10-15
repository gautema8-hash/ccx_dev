const chain = require('../../services/chain');
const { toast } = require('../../utils/util');
const { toastError } = require('../../utils/request');

Page({
  data: {
    themeStyle: '',
    stores: [],
    keyword: '',
    type: '',
    locState: 'IDLE', // IDLE | LOADING | OK | DENIED
    loading: true,
    currentId: '',
    /** 来源页：order 表示从下单流程进来，选完就返回 */
    from: '',
  },

  onLoad(query) {
    this.setData({ from: (query && query.from) || '' });
    const cur = chain.currentStore();
    this.setData({ currentId: cur ? cur.id : '' });
    this.fetch();
  },

  onShow() {
    chain.applyTheme(this);
  },

  onPullDownRefresh() {
    this.fetch().then(() => wx.stopPullDownRefresh());
  },

  /** 取数：先试缓存位置 → 再尝试定位 → 最后不带坐标兜底 */
  fetch() {
    const cached = chain.cachedLocation();
    if (cached) {
      this.setData({ locState: 'OK' });
      return this.load({ latitude: cached.lat, longitude: cached.lng });
    }
    this.setData({ locState: 'LOADING' });
    return chain.getLocation().then((loc) => {
      if (!loc.ok) {
        this.setData({ locState: loc.reason === 'DENIED' ? 'DENIED' : 'IDLE' });
        return this.load({});
      }
      this.setData({ locState: 'OK' });
      return this.load({ latitude: loc.latitude, longitude: loc.longitude });
    });
  },

  load(loc) {
    this.setData({ loading: true });
    /* 记住最近一次有效坐标：搜索/筛选时要带上，否则结果会丢掉距离与「由近到远」排序 */
    if (loc && loc.latitude) this._loc = loc;
    const use = (loc && loc.latitude ? loc : this._loc) || {};
    const opts = { keyword: this.data.keyword, type: this.data.type };
    if (use.latitude) {
      opts.latitude = use.latitude;
      opts.longitude = use.longitude;
    }
    return chain
      .nearbyStores(opts)
      .then((d) => {
        const list = (d && d.list) || [];
        this.locations = list.reduce((m, s) => {
          m[s.id] = s;
          return m;
        }, {});
        this.setData({ stores: list, loading: false });
      })
      .catch((e) => {
        this.setData({ loading: false });
        toastError(e, '门店加载失败');
      });
  },

  /* ---------------- 定位 ---------------- */
  askLocation() {
    chain.getLocation().then((loc) => {
      if (loc.ok) {
        this.setData({ locState: 'OK' });
        return this.load({ latitude: loc.latitude, longitude: loc.longitude });
      }
      /* 已被拒绝过：直接引导去设置页打开 */
      if (loc.reason === 'DENIED') {
        chain.openLocationSetting().then((granted) => {
          if (granted) {
            this.setData({ locState: 'OK' });
            this.load({});
          } else {
            toast('未开启定位，将按门店顺序展示');
          }
        });
        return;
      }
      toast('定位失败，已按门店顺序展示');
    });
  },

  refresh() {
    wx.removeStorageSync('lbz_location_v1');
    this.fetch();
  },

  /* ---------------- 筛选 ---------------- */
  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
    if (this._kt) clearTimeout(this._kt);
    this._kt = setTimeout(() => this.load(this._loc), 300);
  },

  onType(e) {
    const t = e.currentTarget.dataset.t || '';
    if (t === this.data.type) return;
    this.setData({ type: t }, () => this.load(this._loc));
  },

  /* ---------------- 选择门店 ---------------- */
  onPick(e) {
    const id = e.currentTarget.dataset.id;
    const s = this.locations && this.locations[id];
    if (!s) return;
    if (!s.openNow) {
      wx.showModal({
        title: '门店已打烊',
        content: '「' + s.name + '」当前不在营业时间（' + s.openTime + '），仍然切换过去吗？',
        confirmText: '仍然切换',
        confirmColor: '#C62828',
        success: (r) => {
          if (r.confirm) this.commit(s);
        },
      });
      return;
    }
    this.commit(s);
  },

  commit(s) {
    chain.setCurrentStore(s);
    /* 换店后菜单、库存、主题都要重取 */
    require('../../services/menu').clearCache();
    getApp().refreshTheme(s.id).then(() => chain.applyTheme(this));
    wx.showToast({ title: '已切换到 ' + s.name, icon: 'none', duration: 1400 });
    setTimeout(() => {
      if (this.data.from === 'order') wx.navigateBack();
      else wx.redirectTo({ url: '/pages/menu/menu' });
    }, 700);
  },

  onNavigate(e) {
    const s = this.locations && this.locations[e.currentTarget.dataset.id];
    chain.navigateTo(s);
  },

  onCall(e) {
    const s = this.locations && this.locations[e.currentTarget.dataset.id];
    if (!s || !s.phone) return toast('该门店未配置电话');
    wx.makePhoneCall({ phoneNumber: s.phone, fail: () => {} });
  },

  onShareAppMessage() {
    return { title: '老北京麻辣串串香 · 全国门店', path: '/pages/store-list/store-list' };
  },
});
