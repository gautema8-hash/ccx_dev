const chain = require('../../../services/chain');
const auth = require('../../../utils/auth');
const { toast } = require('../../../utils/util');
const { toastError } = require('../../../utils/request');

Page({
  data: {
    themeStyle: '',
    user: {},
    avatarText: '客',
    avatarBroken: false,
    gender: 0,
    genders: [
      { label: '男', value: 1 },
      { label: '女', value: 2 },
      { label: '保密', value: 0 },
    ],
    birthday: '',
    today: '',
    city: '',
    region: ['北京市', '北京市', '东城区'],
    hasPending: false,
    saving: false,
  },

  onLoad() {
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    this.setData({ today });
    this.fill(auth.localUser() || getApp().globalData.userInfo || {});
  },

  onShow() {
    chain.applyTheme(this);
    /* 绑定手机号后返回本页：刷新一次拿最新掩码 */
    if (this._loaded) this.fill(auth.localUser() || {});
    this._loaded = true;
  },

  fill(user) {
    const nickname = String(user.nickname || '');
    /**
     * city 存的是「省 市」两级拼接串，回填给 <picker mode="region"> 必须还原成
     * [省, 市, 区] 三元数组，否则选择器会停在默认项（用户以为资料丢了）。
     */
    const parts = String(user.city || '').split(/\s+/).filter(Boolean);
    this.setData({
      user,
      avatarText: Array.from(nickname || '客')[0] || '客',
      gender: Number(user.gender || 0),
      birthday: user.birthday || '',
      city: user.city || '',
      region: parts.length >= 2 ? [parts[0], parts[1], ''] : ['北京市', '北京市', '东城区'],
    });
    this.pending = {};
  },

  markPending(k, v) {
    this.pending[k] = v;
    this.setData({ hasPending: Object.keys(this.pending).length > 0 });
  },

  /* ---------------- 头像 / 昵称 ---------------- */

  onChooseAvatar(e) {
    const path = e.detail && e.detail.avatarUrl;
    if (!path) return;
    this.setData({ 'user.avatar': path, avatarBroken: false });
    this.markPending('avatar', path);
  },

  onAvatarError() {
    this.setData({ avatarBroken: true });
  },

  onNick(e) {
    const nickname = String((e.detail && e.detail.value) || '').trim();
    if (!nickname || nickname === String(this.data.user.nickname || '')) return;
    this.setData({ 'user.nickname': nickname });
    this.markPending('nickname', nickname);
  },

  /* ---------------- 其他字段 ---------------- */

  onGender(e) {
    const v = Number(e.currentTarget.dataset.v);
    if (v === this.data.gender) return;
    this.setData({ gender: v });
    this.markPending('gender', v);
  },

  onBirthday(e) {
    this.setData({ birthday: e.detail.value });
    this.markPending('birthday', e.detail.value);
  },

  onCity(e) {
    const arr = e.detail.value || [];
    /* 只存「省 市」两级：restaurant 场景按城市做活动，区级粒度没有意义且会让资料显得啰嗦 */
    const city = [arr[0], arr[1]].filter(Boolean).join(' ');
    this.setData({ city: city, region: arr });
    this.markPending('city', city);
  },

  onBindPhone(e) {
    const detail = (e && e.detail) || {};
    if (!detail.encryptedData && !detail.code) return toast('未获取到手机号授权');
    wx.showLoading({ title: '绑定中', mask: true });
    auth
      .bindPhone(detail)
      .then((r) => {
        wx.hideLoading();
        toast('已绑定 ' + (r.phoneMask || ''), 'success');
        this.fill(auth.localUser() || {});
      })
      .catch((err) => {
        wx.hideLoading();
        toastError(err);
      });
  },

  /* ---------------- 保存 ---------------- */

  onSave() {
    const p = this.pending || {};
    if (!Object.keys(p).length) return toast('资料已是最新');
    if (this.data.saving) return;
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });
    auth
      .updateProfile(p)
      .then((user) => {
        wx.hideLoading();
        this.setData({ saving: false });
        getApp().globalData.userInfo = user;
        this.fill(user);
        toast('资料已保存', 'success');
      })
      .catch((e) => {
        wx.hideLoading();
        this.setData({ saving: false });
        toastError(e, '保存失败，请重试');
      });
  },
});
