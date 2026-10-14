Component({
  options: {
    addGlobalClass: true,
    multipleSlots: false,
  },

  properties: {
    /** 当前数量 */
    value: { type: Number, value: 0 },
    /** 最小值；0 表示「零态只显示加号」 */
    min: { type: Number, value: 0 },
    /** 上限（通常传库存） */
    max: { type: Number, value: 99 },
    /** normal | large | small */
    size: { type: String, value: 'normal' },
    disabled: { type: Boolean, value: false },
  },

  data: {
    bounce: false,
  },

  methods: {
    onMinus() {
      if (this.data.disabled) return;
      const next = this.data.value - 1;
      if (next < this.data.min) return;
      this.fire(next);
    },

    onPlus() {
      if (this.data.disabled) return;
      const next = this.data.value + 1;
      if (next > this.data.max) {
        wx.showToast({ title: '已达可点上限', icon: 'none' });
        return;
      }
      this.fire(next);
      this.bounce();
    },

    fire(value) {
      /** change: { value, delta } —— 使用方通过 e.detail.value 取新值 */
      this.triggerEvent('change', {
        value,
        delta: value - this.data.value,
      });
    },

    /** 数字跳动动效，成本极低但手感提升明显 */
    bounce() {
      this.setData({ bounce: true });
      clearTimeout(this._bt);
      this._bt = setTimeout(() => this.setData({ bounce: false }), 150);
    },
  },

  lifetimes: {
    detached() {
      clearTimeout(this._bt);
    },
  },
});
