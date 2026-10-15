const chain = require('../../../services/chain');
const userService = require('../../../services/user');
const { toast, confirm } = require('../../../utils/util');
const { toastError } = require('../../../utils/request');

const PHONE_RE = /^1[3-9]\d{9}$/;
/** 地区默认值：选择器显示什么，表单里就必须是什么，否则用户会看到「已选北京」却提示未选地区 */
const DEFAULT_REGION = ['北京市', '北京市', '东城区'];

Page({
  data: {
    themeStyle: '',
    isEdit: false,
    saving: false,
    id: '',
    region: DEFAULT_REGION,
    regionText: DEFAULT_REGION.join(' '),
    tagOptions: ['家', '公司', '学校'],
    /* 新增时直接带上默认地区，用户不打开选择器也能保存（改动过才覆盖） */
    form: {
      name: '',
      phone: '',
      province: DEFAULT_REGION[0],
      city: DEFAULT_REGION[1],
      district: DEFAULT_REGION[2],
      detail: '',
      tag: '',
      isDefault: false,
    },
  },

  onLoad(query) {
    const id = (query && query.id) || '';
    if (id) {
      this.setData({ isEdit: true, id });
      wx.setNavigationBarTitle({ title: '编辑地址' });
      /* 从列表页取数据，避免再打一次详情接口（列表已含全部字段） */
      const pages = getCurrentPages();
      const prev = pages[pages.length - 2];
      const list = (prev && prev.data && prev.data.list) || [];
      const item = list.find((x) => String(x.id) === String(id));
      if (item) {
        this.setData({
          region: [item.province, item.city, item.district],
          regionText: item.regionText || [item.province, item.city, item.district].join(' '),
          form: {
            name: item.name,
            phone: item.phone,
            province: item.province,
            city: item.city,
            district: item.district,
            detail: item.detail,
            tag: item.tag || '',
            isDefault: !!item.isDefault,
          },
        });
      }
    } else {
      wx.setNavigationBarTitle({ title: '新增地址' });
    }
  },

  onShow() {
    chain.applyTheme(this);
  },

  onInput(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ ['form.' + k]: e.detail.value });
  },

  onRegionChange(e) {
    const arr = e.detail.value || [];
    this.setData({
      region: arr,
      regionText: arr.join(' '),
      'form.province': arr[0] || '',
      'form.city': arr[1] || '',
      'form.district': arr[2] || '',
    });
  },

  onTag(e) {
    const tag = e.currentTarget.dataset.tag;
    this.setData({ 'form.tag': this.data.form.tag === tag ? '' : tag });
  },

  onDefault(e) {
    this.setData({ 'form.isDefault': !!e.detail.value });
  },

  /** 客户端校验：与服务端规则一致，提前拦截减少一次无效请求 */
  validate() {
    const f = this.data.form;
    const name = String(f.name || '').trim();
    const phone = String(f.phone || '').trim();
    const detail = String(f.detail || '').trim();
    if (name.length < 2) return '请填写 2-20 字的联系人姓名';
    if (!PHONE_RE.test(phone)) return '手机号格式不正确';
    if (!f.province || !f.city) return '请选择所在地区';
    if (detail.length < 5) return '详细地址不少于 5 个字（楼栋 / 门牌 / 房号）';
    return '';
  },

  onSave() {
    if (this.data.saving) return;
    const err = this.validate();
    if (err) return toast(err);

    const form = Object.assign({}, this.data.form, {
      name: String(this.data.form.name).trim(),
      phone: String(this.data.form.phone).trim(),
      detail: String(this.data.form.detail).trim(),
    });
    this.setData({ saving: true });
    const task = this.data.isEdit ? userService.updateAddress(this.data.id, form) : userService.createAddress(form);
    task
      .then(() => {
        this.setData({ saving: false });
        toast('已保存', 'success');
        setTimeout(() => wx.navigateBack(), 500);
      })
      .catch((e) => {
        this.setData({ saving: false });
        toastError(e);
      });
  },

  onDelete() {
    confirm('删除这个地址？').then((ok) => {
      if (!ok) return;
      userService
        .deleteAddress(this.data.id)
        .then(() => {
          toast('已删除', 'success');
          setTimeout(() => wx.navigateBack(), 400);
        })
        .catch((e) => toastError(e));
    });
  },
});
