/**
 * 发票抬头管理
 * 取代原先「我的 → 发票抬头」的两级 showModal 输入（原生弹窗不能校验、不能填邮箱），
 * 改为列表页 + 底部表单弹层，字段与后端 mp_invoice 一致。
 */
const chain = require('../../../services/chain');
const userService = require('../../../services/user');
const { toast, confirm } = require('../../../utils/util');
const { toastError } = require('../../../utils/request');

/** 邮箱校验：与后端 saveInvoice 的宽松策略一致，只挡明显错误的输入 */
const EMAIL_RE = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;
const TAX_RE = /^[0-9A-Z]{15,20}$/;

const emptyForm = () => ({ titleType: 'personal', title: '', taxNo: '', email: '' });

Page({
  data: {
    themeStyle: '',
    list: [],
    loading: true,
    showForm: false,
    form: emptyForm(),
  },

  onShow() {
    chain.applyTheme(this);
    this.fetch();
  },

  fetch() {
    this.setData({ loading: true });
    return userService
      .listInvoice()
      .then((list) => this.setData({ list: list || [] }))
      .catch((e) => toastError(e, '抬头加载失败'))
      .then(() => this.setData({ loading: false }));
  },

  /* ---------------- 新增 ---------------- */
  openForm() {
    if (this.data.list.length >= 10) {
      toast('最多保存 10 个抬头');
      return;
    }
    this.setData({ showForm: true, form: emptyForm() });
  },

  closeForm() {
    this.setData({ showForm: false });
  },

  /** 阻止点弹层内部时冒泡到遮罩导致误关闭 */
  noop() {},

  onType(e) {
    const t = e.currentTarget.dataset.t;
    /* 切到个人时清掉税号，避免残留「个人抬头带税号」的脏数据 */
    const patch = { 'form.titleType': t };
    if (t === 'personal') patch['form.taxNo'] = '';
    this.setData(patch);
  },

  onInput(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.k]: e.detail.value });
  },

  onSave() {
    const f = this.data.form;
    const title = String(f.title || '').trim();
    const taxNo = String(f.taxNo || '').trim().toUpperCase();
    const email = String(f.email || '').trim();

    if (!title) return toast('请填写发票抬头');
    if (f.titleType === 'company' && !TAX_RE.test(taxNo)) {
      return toast('纳税人识别号格式不正确');
    }
    if (email && !EMAIL_RE.test(email)) return toast('邮箱格式不正确');

    wx.showLoading({ title: '保存中', mask: true });
    userService
      .saveInvoice({ title, taxNo: f.titleType === 'company' ? taxNo : '', email, titleType: f.titleType })
      .then(() => {
        wx.hideLoading();
        this.setData({ showForm: false });
        toast('已保存', 'success');
        this.fetch();
      })
      .catch((e) => {
        wx.hideLoading();
        toastError(e, '保存失败');
      });
  },

  /* ---------------- 复制 / 删除 ---------------- */
  onCopy(e) {
    wx.setClipboardData({
      data: e.currentTarget.dataset.title || '',
      success: () => toast('已复制抬头', 'success'),
    });
  },

  onDelete(e) {
    const { id, title } = e.currentTarget.dataset;
    confirm('删除抬头「' + title + '」？已提交的开票申请不受影响。', '删除确认').then((ok) => {
      if (!ok) return;
      userService
        .deleteInvoice(id)
        .then(() => {
          toast('已删除', 'success');
          this.fetch();
        })
        .catch((err) => toastError(err, '删除失败'));
    });
  },
});
