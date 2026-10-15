/**
 * 门店详情页（从「选择门店」列表点击进入）
 * 顶部用原生 map 组件展示门店位置（微信内即为腾讯地图底图），
 * 下面依次是门店信息、在售能力、操作按钮（导航 / 电话 / 选为下单门店）。
 */
const chain = require('../../services/chain');
const menuService = require('../../services/menu');
const { toast } = require('../../utils/util');
const { toastError } = require('../../utils/request');

Page({
  data: {
    themeStyle: '',
    id: '',
    store: null,
    loading: true,
    markers: [],
    /** 地图中心点：没有坐标时退回北京簋街，避免地图空白 */
    center: { latitude: 39.9403, longitude: 116.4216 },
    tableText: '',
    currentId: '',
    sameStore: false,
  },

  onLoad(query) {
    this.setData({ id: (query && query.id) || '' });
    chain.applyTheme(this);
    this.fetch();
  },

  fetch() {
    if (!this.data.id) {
      this.setData({ loading: false });
      return Promise.resolve();
    }
    const loc = chain.cachedLocation();
    const opts = loc ? { latitude: loc.lat, longitude: loc.lng } : {};
    this.setData({ loading: true });
    return chain
      .storeDetail(this.data.id, opts)
      .then((store) => {
        if (!store) {
          this.setData({ store: null, loading: false });
          return;
        }
        const lat = Number(store.latitude);
        const lng = Number(store.longitude);
        const cur = chain.currentStore();
        const tables = store.tables || [];
        wx.setNavigationBarTitle({ title: store.name });
        this.setData({
          store,
          loading: false,
          currentId: cur ? cur.id : '',
          sameStore: !!(cur && cur.id === store.id),
          /* 桌号可能很多，只展示前 8 个 + 总数，避免把信息行撑成三行 */
          tableText: tables.length
            ? tables.slice(0, 8).join('、') + (tables.length > 8 ? ' 等 ' + tables.length + ' 桌' : '')
            : '',
          center: lat && lng ? { latitude: lat, longitude: lng } : this.data.center,
          markers:
            lat && lng
              ? [
                  {
                    id: 1,
                    latitude: lat,
                    longitude: lng,
                    width: 32,
                    height: 32,
                    callout: {
                      content: store.name,
                      color: '#1F1F1F',
                      fontSize: 12,
                      borderRadius: 6,
                      padding: 6,
                      bgColor: '#FFFFFF',
                      display: 'ALWAYS',
                    },
                  },
                ]
              : [],
        });
      })
      .catch((e) => {
        this.setData({ store: null, loading: false });
        toastError(e, '门店信息加载失败');
      });
  },

  /** 地图内点击气泡 → 打开系统地图导航 */
  onMarkerTap() {
    if (this.data.store) chain.navigateTo(this.data.store);
  },

  onNavigate() {
    if (!this.data.store) return;
    chain.navigateTo(this.data.store);
  },

  onCall() {
    const s = this.data.store;
    if (!s || !s.phone) return toast('该门店未配置电话');
    wx.makePhoneCall({ phoneNumber: s.phone, fail: () => {} });
  },

  onCopyAddress() {
    const s = this.data.store;
    if (!s || !s.address) return;
    wx.setClipboardData({ data: s.address, success: () => toast('地址已复制', 'success') });
  },

  /** 选为当前下单门店：切店后菜单/库存/主题全部重取 */
  onUse() {
    const s = this.data.store;
    if (!s) return;
    if (this.data.sameStore) {
      wx.switchTab({ url: '/pages/menu/menu' });
      return;
    }
    const commit = () => {
      chain.setCurrentStore(s);
      menuService.clearCache();
      getApp()
        .refreshTheme(s.id)
        .then(() => chain.applyTheme(this))
        .catch(() => {});
      toast('已切换到 ' + s.name, 'success');
      setTimeout(() => wx.switchTab({ url: '/pages/menu/menu' }), 600);
    };
    if (!s.openNow) {
      wx.showModal({
        title: '门店已打烊',
        content: '「' + s.name + '」当前不在营业时间（' + s.openTime + '），仍然切换过去吗？',
        confirmText: '仍然切换',
        confirmColor: '#C62828',
        success: (r) => {
          if (r.confirm) commit();
        },
      });
      return;
    }
    commit();
  },

  onShareAppMessage() {
    const s = this.data.store || {};
    return {
      title: s.name ? s.name + ' · 老北京麻辣串串香' : '老北京麻辣串串香',
      path: '/pages/store-detail/store-detail?id=' + this.data.id,
    };
  },
});
