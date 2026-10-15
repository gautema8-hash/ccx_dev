/**
 * 选择门店
 * 定位 → 下拉筛选（营业状态 / 门店类型 / 距离范围）+ 关键词搜索 → 列表按距离升序 → 点击进门店页。
 * 「选择该店」按钮保留一键切换能力（从下单流程进来时选完即返回）。
 */
const chain = require('../../services/chain');
const { toast } = require('../../utils/util');
const { toastError } = require('../../utils/request');

const TYPE_LABEL = { '': '全部类型', DIRECT: '直营店', FRANCHISE: '加盟店' };

Page({
  data: {
    themeStyle: '',
    stores: [],
    keyword: '',
    type: '', // '' | DIRECT | FRANCHISE
    onlyOpen: false,
    maxKm: 0, // 0 表示不限
    panel: '', // '' | state | type | range
    typeLabel: TYPE_LABEL[''],
    rangeLabel: '不限距离',
    locState: 'IDLE', // IDLE | LOADING | OK | DENIED
    hasLocation: false,
    sortText: '已按距你由近到远排序',
    hasFilter: false,
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
      this.setData({ locState: 'OK', hasLocation: true, sortText: '已按距你由近到远排序' });
      return this.load({ latitude: cached.lat, longitude: cached.lng });
    }
    this.setData({ locState: 'LOADING' });
    return chain.getLocation().then((loc) => {
      if (!loc.ok) {
        this.setData({
          locState: loc.reason === 'DENIED' ? 'DENIED' : 'IDLE',
          hasLocation: false,
          sortText: '未定位 · 已按门店顺序展示',
        });
        return this.load({});
      }
      this.setData({ locState: 'OK', hasLocation: true, sortText: '已按距你由近到远排序' });
      return this.load({ latitude: loc.latitude, longitude: loc.longitude });
    });
  },

  load(loc) {
    this.setData({ loading: true });
    /* 记住最近一次有效坐标：搜索/筛选时要带上，否则结果会丢掉距离与「由近到远」排序 */
    if (loc && loc.latitude) this._loc = loc;
    const use = (loc && loc.latitude ? loc : this._loc) || {};
    const opts = {
      keyword: this.data.keyword,
      type: this.data.type,
      onlyOpen: this.data.onlyOpen,
      maxKm: this.data.hasLocation ? this.data.maxKm : 0,
    };
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
        this.setData({ locState: 'OK', hasLocation: true, sortText: '已按距你由近到远排序' });
        return this.load({ latitude: loc.latitude, longitude: loc.longitude });
      }
      /* 已被拒绝过：直接引导去设置页打开 */
      if (loc.reason === 'DENIED') {
        chain.openLocationSetting().then((granted) => {
          if (granted) {
            this.setData({ locState: 'OK', hasLocation: true, sortText: '已按距你由近到远排序' });
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

  /* ---------------- 搜索 ---------------- */
  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
    this.syncFilter();
    if (this._kt) clearTimeout(this._kt);
    this._kt = setTimeout(() => this.load(this._loc), 300);
  },

  clearKeyword() {
    this.setData({ keyword: '' });
    this.syncFilter();
    this.load(this._loc);
  },

  /* ---------------- 下拉筛选 ---------------- */
  togglePanel(e) {
    const p = e.currentTarget.dataset.p;
    this.setData({ panel: this.data.panel === p ? '' : p });
  },

  closePanel() {
    this.setData({ panel: '' });
  },

  onState(e) {
    const onlyOpen = !!e.currentTarget.dataset.v;
    if (onlyOpen === this.data.onlyOpen) return this.closePanel();
    this.setData({ onlyOpen, panel: '' });
    this.syncFilter();
    this.load(this._loc);
  },

  onType(e) {
    const t = e.currentTarget.dataset.v || '';
    if (t === this.data.type) return this.closePanel();
    this.setData({ type: t, typeLabel: TYPE_LABEL[t] || '全部类型', panel: '' });
    this.syncFilter();
    this.load(this._loc);
  },

  onRange(e) {
    const km = Number(e.currentTarget.dataset.v) || 0;
    if (!this.data.hasLocation) {
      this.closePanel();
      toast('请先开启定位才能按距离筛选');
      return;
    }
    if (km === this.data.maxKm) return this.closePanel();
    this.setData({ maxKm: km, rangeLabel: km ? km + 'km 内' : '不限距离', panel: '' });
    this.syncFilter();
    this.load(this._loc);
  },

  resetFilter() {
    this.setData({
      keyword: '',
      type: '',
      onlyOpen: false,
      maxKm: 0,
      typeLabel: TYPE_LABEL[''],
      rangeLabel: '不限距离',
      hasFilter: false,
    });
    this.load(this._loc);
  },

  /** 是否有生效中的筛选条件：决定空态文案与「清除筛选」按钮 */
  syncFilter() {
    const d = this.data;
    this.setData({ hasFilter: !!(d.keyword || d.type || d.onlyOpen || d.maxKm) });
  },

  /* ---------------- 门店操作 ---------------- */
  goDetail(e) {
    wx.navigateTo({ url: '/pages/store-detail/store-detail?id=' + e.currentTarget.dataset.id });
  },

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
      else wx.switchTab({ url: '/pages/menu/menu' });
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
