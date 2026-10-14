Component({
  options: {
    addGlobalClass: true,
  },

  properties: {
    /** 是否展示 */
    show: { type: Boolean, value: false },
    /** 菜品对象（含 spicyOptions / price / priceText / unit / stock） */
    dish: { type: Object, value: null },
    /** 打开时的默认辣度（来自该菜品上次选择） */
    initialSpicy: { type: String, value: '' },
    /** 打开时的默认数量 */
    initialCount: { type: Number, value: 1 },
  },

  data: {
    curSpicyId: '',
    curSpicyName: '',
    curCount: 1,
    totalText: '0.00',
  },

  observers: {
    'show, dish': function (show, dish) {
      if (!show || !dish) return;
      const options = dish.spicyOptions || [];
      let spicyId = this.data.initialSpicy;
      if (!spicyId || !options.some((o) => o.id === spicyId)) {
        // 默认选「微微辣」—— 大多数北方客群的实际选择，降低决策成本
        spicyId = options[1] ? options[1].id : options[0] ? options[0].id : '';
      }
      const count = Math.max(1, this.data.initialCount || 1);
      this.setData(
        Object.assign(
          {
            curSpicyId: spicyId,
            curSpicyName: this.nameOf(spicyId, options),
            curCount: count,
          },
          { totalText: this.calc(count) }
        )
      );
    },
  },

  methods: {
    nameOf(id, options) {
      const hit = (options || this.data.dish && this.data.dish.spicyOptions || []).find(
        (o) => o.id === id
      );
      return hit ? hit.name : '';
    },

    calc(count) {
      const dish = this.data.dish;
      if (!dish) return '0.00';
      return ((dish.price * count) / 100).toFixed(2);
    },

    onPickSpicy(e) {
      const { id, name } = e.currentTarget.dataset;
      this.setData({ curSpicyId: id, curSpicyName: name });
    },

    onCountChange(e) {
      const count = e.detail.value;
      this.setData({ curCount: count, totalText: this.calc(count) });
    },

    onConfirm() {
      const dish = this.data.dish;
      if (!dish) return;
      const { curSpicyId, curSpicyName, curCount } = this.data;
      if (dish.spicy && !curSpicyId) {
        wx.showToast({ title: '请选择辣度', icon: 'none' });
        return;
      }
      this.triggerEvent('confirm', {
        dishId: dish.id,
        spicyId: curSpicyId,
        spicyName: curSpicyName,
        count: curCount,
      });
    },

    onClose() {
      this.triggerEvent('close');
    },

    /** 阻断蒙层下的页面滚动（iOS 上必须） */
    noop() {},
  },
});
