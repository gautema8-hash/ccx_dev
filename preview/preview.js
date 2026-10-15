/* ============================================================
   老北京麻辣串串香 · 点单小程序 预览版视图层
   ------------------------------------------------------------
   业务代码全部复用小程序源码（由构建脚本内联）：
     utils/cart.js     购物车状态中心（发布订阅 + 持久化）
     utils/auth.js     静默登录 / 用户资料
     utils/util.js     分元换算 / 时间格式化
     services/menu.js  菜单 + 缓存
     services/order.js 订单 + 状态机
     mock/menu.js      6 分类 / 30 菜品 / 4 锅底 / 4 蘸料 / 4 档辣度
     mock/coupon.js    优惠券 + 抵扣计算
   本文件只负责把 WXML/WXSS 翻译成 HTML/CSS 与事件绑定。
   ============================================================ */
(function () {
  'use strict';

  const MENU_SVC = __require('services/menu.js');
  const CART = __require('utils/cart.js');
  const ORDER = __require('services/order.js');
  const AUTH = __require('utils/auth.js');
  const MOCK_COUPON = __require('mock/coupon.js');
  const UTIL = __require('utils/util.js');

  /* ---------------------------------------------------------- 状态 */
  const S = {
    screen: 'menu',
    loading: true,
    menu: null,
    dishMap: {},
    dishCategory: {},
    activeCat: '',
    lockSync: false,
    sectionTops: [],

    countMap: {},
    catCount: {},
    cartSummary: { count: 0, kinds: 0, totalText: '0.00', soupFee: 0, soupFeeText: '0.00' },

    diningType: 'dinein',
    tableNo: '',
    tables: [],

    skuShow: false,
    skuDish: null,
    skuSpicy: '',
    skuCount: 1,

    cartItems: [],
    dipChecked: {},

    coupons: [],
    coupon: null,
    discountText: '0.00',
    payText: '0.00',
    usableCount: 0,
    submitting: false,

    orders: [],
    ordersFilter: 'all',
    ordersCounts: {},

    order: null,
    polling: false,

    user: {},
    stats: { orderCount: 0, ongoingCount: 0, couponCount: 0 },
  };

  const TITLES = {
    menu: '点单',
    cart: '购物车',
    confirm: '确认订单',
    orders: '我的订单',
    'order-detail': '订单详情',
    mine: '我的',
  };
  const TABS = [
    { key: 'menu', icon: '🍢', text: '点单' },
    { key: 'cart', icon: '🛒', text: '购物车' },
    { key: 'orders', icon: '🧾', text: '订单' },
    { key: 'mine', icon: '👤', text: '我的' },
  ];

  /* ---------------------------------------------------------- 工具 */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  const fen = (n) => (Number(n || 0) / 100).toFixed(2);

  /* ---------------------------------------------------------- UI 基础件 */
  const UI = {
    _tt: null,
    toast(title) {
      const el = $('#toast');
      el.textContent = title;
      el.classList.add('on');
      clearTimeout(this._tt);
      this._tt = setTimeout(() => el.classList.remove('on'), 1700);
    },

    _pending: null,
    modal(opt, success, complete) {
      const root = $('#modal-root');
      const showCancel = opt.showCancel !== false;
      root.innerHTML = `
        <div class="modal-mask">
          <div class="modal">
            <div class="modal__title">${esc(opt.title || '提示')}</div>
            <div class="modal__body">${esc(opt.content || '')}</div>
            <div class="modal__foot">
              ${showCancel ? `<button class="modal__btn" data-r="0">${esc(opt.cancelText || '取消')}</button>` : ''}
              <button class="modal__btn primary" data-r="1">${esc(opt.confirmText || '确定')}</button>
            </div>
          </div>
        </div>`;
      const close = (ok) => {
        root.innerHTML = '';
        if (success) success({ confirm: ok, cancel: !ok });
        if (complete) complete({ confirm: ok, cancel: !ok });
      };
      $$('.modal__btn', root).forEach((b) =>
        b.addEventListener('click', () => close(b.dataset.r === '1'))
      );
    },

    /** 自定义列表弹窗（优惠券选择） */
    picker(title, options, onPick) {
      const root = $('#modal-root');
      root.innerHTML = `
        <div class="modal-mask">
          <div class="modal">
            <div class="modal__title">${esc(title)}</div>
            <div class="modal__list">
              ${options
                .map(
                  (o, i) =>
                    `<div class="modal__opt ${o.disabled ? 'dis' : ''}" data-i="${i}">
                       <span>${esc(o.label)}</span><b>${esc(o.right || '')}</b>
                     </div>`
                )
                .join('')}
            </div>
            <div class="modal__foot">
              <button class="modal__btn" data-r="0">取消</button>
            </div>
          </div>
        </div>`;
      $$('.modal__opt', root).forEach((el) =>
        el.addEventListener('click', () => {
          const o = options[Number(el.dataset.i)];
          if (o.disabled) {
            UI.toast('未达到使用门槛');
            return;
          }
          root.innerHTML = '';
          onPick(o, Number(el.dataset.i));
        })
      );
      $$('.modal__btn', root).forEach((b) =>
        b.addEventListener('click', () => (root.innerHTML = ''))
      );
    },

    loading(title) {
      const el = $('#loading');
      $('.loading-box', el).textContent = title || '加载中';
      el.hidden = false;
    },
    loadingHide() {
      $('#loading').hidden = true;
    },
  };
  window.__UI = UI;

  /* ---------------------------------------------------------- 渲染骨架 */
  function navbarHtml() {
    const isTab = ['menu', 'cart', 'orders', 'mine'].indexOf(S.screen) > -1;
    const canBack = S.screen === 'confirm' || S.screen === 'order-detail';
    return `
      <div class="navbar ${S.screen === 'menu' ? 'navbar--brand' : ''}">
        ${canBack ? '<div class="navbar__back" onclick="A.back()">‹</div>' : ''}
        ${esc(TITLES[S.screen] || '')}
        <div class="navbar__capsule">•••<i></i>⊙</div>
      </div>`;
  }

  function tabbarHtml() {
    const isTab = ['menu', 'cart', 'orders', 'mine'].indexOf(S.screen) > -1;
    const count = S.cartSummary.count;
    return `<nav class="tabbar ${isTab ? '' : 'hidden'}">
      ${TABS.map(
        (t) => `
        <div class="tabbar__item ${S.screen === t.key ? 'on' : ''}" onclick="A.goTab('${t.key}')">
          <div class="tabbar__icon">${t.icon}</div>
          <div>${t.text}</div>
          ${t.key === 'cart' && count ? `<div class="tabbar__badge">${count > 99 ? '99+' : count}</div>` : ''}
        </div>`
      ).join('')}
    </nav>`;
  }

  function render() {
    $('#navbar-root').innerHTML = navbarHtml();
    const keep = $('#pscroll') ? $('#pscroll').scrollTop : 0;
    const map = {
      menu: screenMenu,
      cart: screenCart,
      confirm: screenConfirm,
      orders: screenOrders,
      'order-detail': screenOrderDetail,
      mine: screenMine,
    };
    $('#screen').innerHTML = (map[S.screen] || screenMenu)();
    $('#tabbar-root').innerHTML = tabbarHtml();
    const sc = $('#pscroll');
    if (sc && keep) sc.scrollTop = keep;
    if (S.screen === 'menu') requestAnimationFrame(measureSections);
  }

  /* ---------------------------------------------------------- 规格弹层 */
  function stepperHtml(o) {
    const show = o.value > o.min || o.min > 0;
    return `<div class="stepper ${o.size || ''}">
      ${show
        ? `<button class="stepper__btn stepper__minus ${o.value <= o.min ? 'off' : ''}" onclick="A.${o.act}('${o.id}',-1)">−</button>
           <div class="stepper__num" id="${o.numId || ''}">${o.value}</div>`
        : ''}
      <button class="stepper__btn stepper__plus" onclick="A.${o.act}('${o.id}',1)">+</button>
    </div>`;
  }

  function renderSku() {
    const d = S.skuDish;
    const root = $('#sku-root');
    if (!d) {
      root.innerHTML = '';
      return;
    }
    const opts = d.spicyOptions || [];
    const total = ((d.price * S.skuCount) / 100).toFixed(2);
    root.innerHTML = `
      <div class="sku-mask ${S.skuShow ? 'on' : ''}" onclick="A.skuClose()"></div>
      <div class="sku-panel ${S.skuShow ? 'on' : ''}">
        <div class="sku-head">
          <div class="sku-head__emoji">${d.emoji}</div>
          <div class="sku-head__main">
            <div class="sku-head__name">${esc(d.name)}</div>
            <div class="sku-head__desc ell">${esc(d.desc)}</div>
            <div class="sku-head__price"><span class="price__u">¥</span><b>${d.priceText}</b><i>/${d.unit}</i></div>
          </div>
          <div class="sku-head__close" onclick="A.skuClose()">✕</div>
        </div>
        <div class="sku-body">
          <div class="sku-group">
            <div class="sku-group__title">辣度<span class="sku-group__req">必选</span>
              <span class="sku-group__picked">${esc(UTIL ? '' : '')}${esc(
      (opts.find((o) => o.id === S.skuSpicy) || {}).name || ''
    )}</span>
            </div>
            <div class="sku-opts">
              ${opts
                .map(
                  (o) => `
                <div class="sku-opt ${S.skuSpicy === o.id ? 'on' : ''}"
                     style="${S.skuSpicy === o.id ? `border-color:${o.color};color:${o.color};background:${o.color}12` : ''}"
                     onclick="A.skuPick('${o.id}')">
                  <span class="sku-opt__dot" style="background:${o.color}"></span>${esc(o.name)}
                </div>`
                )
                .join('')}
            </div>
          </div>
          <div class="sku-group">
            <div class="sku-group__title">数量</div>
            <div class="sku-qty">
              ${stepperHtml({ value: S.skuCount, min: 1, max: d.stock, size: 'lg', act: 'skuCount', id: 'x' })}
              <span class="sku-qty__unit">约 ${S.skuCount}${esc(d.unit)}</span>
            </div>
          </div>
          <div class="sku-tip">💡 锅底与蘸料是整单选项，加入购物车后统一选择</div>
        </div>
        <div class="sku-foot">
          <div>
            <div class="sku-foot__label">小计</div>
            <div class="price"><span class="price__u">¥</span><span class="sku-foot__num">${total}</span></div>
          </div>
          <button class="sku-foot__btn" onclick="A.skuConfirm()">加入购物车</button>
        </div>
      </div>`;
  }

  /* ---------------------------------------------------------- 页面：点单 */
  function dishControl(d, n) {
    if (d.spicy) {
      return `${n ? `<div class="dish__qty">${n}</div>` : ''}
              <button class="dish__add" onclick="A.addDish('${d.id}')">+</button>`;
    }
    return stepperHtml({ value: n, min: 0, max: d.stock, size: 'sm', act: 'dishStep', id: d.id });
  }

  function dishRow(d, n) {
    return `<div class="dish">
      <div class="dish__img"><span>${d.emoji}</span>${d.sold > 5000 ? '<div class="dish__hot">热销</div>' : ''}</div>
      <div class="dish__main">
        <div class="dish__name ell">${esc(d.name)}</div>
        <div class="dish__desc ell">${esc(d.desc)}</div>
        <div class="dish__tags">
          ${d.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
          ${d.spicy ? '<span class="tag tag--accent">可选辣度</span>' : ''}
        </div>
        <div class="dish__bottom">
          <div class="dish__price"><span class="price__u">¥</span><b>${d.priceText}</b><i>/${esc(d.unit)}</i></div>
          <div id="ctl-${d.id}">${dishControl(d, n)}</div>
        </div>
      </div>
    </div>`;
  }

  function cartbarHtml() {
    const c = S.cartSummary;
    return `<div class="cartbar">
      <div class="cartbar__left" onclick="A.goTab('cart')">
        <div class="cartbar__icon ${c.count ? 'on' : ''}">🛒${
      c.count ? `<div class="cartbar__badge">${c.count > 99 ? '99+' : c.count}</div>` : ''
    }</div>
        <div class="cartbar__text">
          ${
            c.count
              ? `<div class="cartbar__amount"><span class="price__u">¥</span>${c.totalText}${
                  c.soupFee ? `<em>含锅底 ¥${c.soupFeeText}</em>` : ''
                }</div>
                 <div class="cartbar__sub">已选 ${c.count} 件 · ${c.kinds} 种</div>`
              : '<div class="cartbar__empty">还没选串，点「+」开始吧</div>'
          }
        </div>
      </div>
      <button class="cartbar__btn ${c.count ? 'on' : ''}" onclick="A.goTab('cart')">${c.count ? '去结算' : '选好了'}</button>
    </div>`;
  }

  function screenMenu() {
    if (S.loading || !S.menu) {
      return `<div class="body" style="background:#fff">
        ${[1, 2, 3]
          .map(
            () => `<div class="sk">
              <div class="sk__img"></div>
              <div style="flex:1;padding-top:6px">
                <div class="sk__l" style="width:60%"></div>
                <div class="sk__l" style="width:90%"></div>
                <div class="sk__l" style="width:35%"></div>
              </div>
            </div>`
          )
          .join('')}
      </div>`;
    }
    const m = S.menu;
    const shop = m.shop;
    return `
      <div class="shop">
        <div class="shop__top">
          <div class="shop__logo">${shop.logo}</div>
          <div class="shop__info">
            <div class="shop__name ell">${esc(shop.name)}</div>
            <div class="shop__notice ell">${esc(shop.notice)}</div>
          </div>
        </div>
        <div class="shop__bottom">
          <div class="seg">
            <div class="seg__item ${S.diningType === 'dinein' ? 'on' : ''}" onclick="A.setDining('dinein')">堂食</div>
            <div class="seg__item ${S.diningType === 'takeout' ? 'on' : ''}" onclick="A.setDining('takeout')">到店自取</div>
          </div>
          ${
            S.diningType === 'dinein'
              ? `<select class="shop__table" onchange="A.setTable(this.value)">
                   ${S.tables.map((t) => `<option ${t === S.tableNo ? 'selected' : ''}>${esc(t)}</option>`).join('')}
                 </select>`
              : '<span style="font-size:11px;opacity:.8">自取免排队 · 打包费 ¥1.00</span>'
          }
        </div>
      </div>
      <div class="body">
        <div class="cats" id="cats">
          ${m.categories
            .map(
              (cat) => `
            <div class="cat ${S.activeCat === cat.id ? 'on' : ''}" id="cat-${cat.id}" onclick="A.tapCat('${cat.id}')">
              <div class="cat__emoji">${cat.emoji}</div>
              <div class="cat__name">${esc(cat.name)}</div>
              ${S.catCount[cat.id] ? `<div class="cat__badge">${S.catCount[cat.id]}</div>` : ''}
            </div>`
            )
            .join('')}
        </div>
        <div class="dishes" id="dishes" onscroll="A.onDishScroll()">
          ${m.categories
            .map(
              (cat) => `
            <div id="sec-${cat.id}">
              <div class="sec__title">${esc(cat.name)}<span class="sec__count">${cat.dishes.length} 款</span></div>
              ${cat.dishes.map((d) => dishRow(d, S.countMap[d.id] || 0)).join('')}
            </div>`
            )
            .join('')}
          <div class="list-end">— 共 ${m.totalDishes} 款菜品，已到底部 —</div>
          <div style="height:76px"></div>
        </div>
      </div>
      ${cartbarHtml()}`;
  }

  /* ---------------------------------------------------------- 页面：购物车 */
  function screenCart() {
    const st = CART.get();
    if (!st.items.length) {
      return `<div class="empty">
        <div class="empty__icon">🛒</div>
        <div class="empty__text">购物车还是空的</div>
        <div class="empty__btn" onclick="A.goTab('menu')">去选串串</div>
      </div>`;
    }
    const sum = S.cartSummary;
    const soups = (S.menu && S.menu.soups) || [];
    const dips = (S.menu && S.menu.dips) || [];
    const dipsText = st.dips.map((d) => d.name).join('、');

    return `
    <div class="pscroll" id="pscroll">
      <div class="card">
        <div class="between">
          <div class="lbl">就餐方式</div>
          <div class="seg">
            <div class="seg__item ${st.diningType === 'dinein' ? 'on' : ''}" onclick="A.setDining('dinein')">堂食</div>
            <div class="seg__item ${st.diningType === 'takeout' ? 'on' : ''}" onclick="A.setDining('takeout')">到店自取</div>
          </div>
        </div>
        ${
          st.diningType === 'dinein'
            ? `<div class="between mt">
                 <div class="lbl">桌号</div>
                 <select class="shop__table" style="background:#fafafc;color:#c62828;border:1px solid #ededf0" onchange="A.setTable(this.value)">
                   ${S.tables.map((t) => `<option ${t === st.tableNo ? 'selected' : ''}>${esc(t)}</option>`).join('')}
                 </select>
               </div>`
            : ''
        }
        <div class="between mt">
          <div class="lbl">就餐人数</div>
          ${stepperHtml({ value: st.peopleCount, min: 1, max: 20, size: 'sm', act: 'people', id: 'x' })}
        </div>
        ${st.diningType === 'takeout' ? '<div class="tip mt">自取订单会增加 ¥1.00 打包费，到店后凭取餐码取餐</div>' : ''}
      </div>

      <div class="block-title">选锅底<span class="block-title__req">必选 1 项</span></div>
      <div class="soups">
        ${soups
          .map(
            (s) => `
          <div class="soup ${st.soup && st.soup.id === s.id ? 'on' : ''}" onclick="A.pickSoup('${s.id}')">
            ${s.recommended ? '<div class="soup__badge">推荐</div>' : ''}
            <div class="soup__emoji">${s.emoji}</div>
            <div class="soup__name ell">${esc(s.name)}</div>
            <div class="soup__price">¥${s.priceText}</div>
          </div>`
          )
          .join('')}
      </div>

      <div class="block-title">选蘸料<span class="block-title__sub">可多选 · 免费</span></div>
      <div class="card dips">
        ${dips
          .map(
            (d) => `
          <div class="dip ${S.dipChecked[d.id] ? 'on' : ''}" onclick="A.toggleDip('${d.id}','${esc(d.name)}')">
            ${d.emoji}${esc(d.name)}${S.dipChecked[d.id] ? ' ✓' : ''}
          </div>`
          )
          .join('')}
      </div>

      <div class="block-title">已选明细
        <span class="block-title__sub">${sum.count} 件 / ${st.items.length} 种</span>
        <span class="block-title__clear" onclick="A.clearItems()">清空</span>
      </div>
      <div class="card">
        ${S.cartItems
          .map(
            (it) => `
          <div class="item">
            <div class="item__img">${it.emoji}</div>
            <div class="item__main">
              <div class="item__name-wrap">
                <div class="item__name ell">${esc(it.name)}</div>
                <div class="item__del" onclick="A.delItem('${it.key}')">✕</div>
              </div>
              <div class="item__spec"><span>${it.spicyName ? '🌶 ' + esc(it.spicyName) : '默认口味'}</span></div>
              <div class="item__bottom">
                <div class="item__price"><span class="price__u">¥</span>${it.priceText}<i>/${esc(it.unit)}</i></div>
                ${stepperHtml({ value: it.count, min: 0, max: 99, size: 'sm', act: 'itemStep', id: it.key })}
              </div>
            </div>
          </div>`
          )
          .join('')}
        <div class="items__tip">在小程序里是「长按删除」，预览版为了好点改成了右上角 ✕</div>
      </div>

      <div class="card">
        <div class="lbl">口味备注</div>
        <textarea class="remark" id="remark" maxlength="100" placeholder="例如：牛肉串涮久一点 / 不要香菜 / 少放油"
          onchange="A.remarkChange(this.value)">${esc(st.remark)}</textarea>
        <div class="remark__count">${(st.remark || '').length}/100</div>
      </div>

      <div class="card amounts">
        <div class="between"><span class="muted">菜品小计</span><span>¥${sum.goodsText}</span></div>
        <div class="between mt-s"><span class="muted">锅底${st.soup ? '（' + esc(st.soup.name) + '）' : ''}</span><span>¥${sum.soupFeeText}</span></div>
        ${sum.packFee ? `<div class="between mt-s"><span class="muted">打包费</span><span>¥${sum.packFeeText}</span></div>` : ''}
        <div class="divider"></div>
        <div class="between"><span class="lbl">合计</span>
          <span class="price total"><span class="price__u">¥</span>${sum.totalText}</span></div>
      </div>
      <div class="holder"></div>
    </div>

    <div class="actionbar">
      <div class="actionbar__left">
        <div class="actionbar__label">合计</div>
        <div class="actionbar__amount"><span class="price__u">¥</span>${sum.totalText}</div>
        ${!sum.canSubmit ? `<div class="actionbar__warn">${esc(blockReason(sum, st))}</div>` : ''}
      </div>
      <button class="btn-primary actionbar__btn ${sum.canSubmit ? '' : 'disabled'}" onclick="A.goConfirm()">
        去结算(${sum.count})
      </button>
    </div>`;
  }

  function blockReason(sum, st) {
    if (!st.items.length) return '请先选择菜品';
    if (!st.soup) return '请选择锅底';
    if (st.diningType === 'dinein' && !st.tableNo) return '请选择桌号';
    return '';
  }

  /* ---------------------------------------------------------- 页面：结算 */
  function screenConfirm() {
    const st = CART.get();
    const sum = S.cartSummary;
    const items = CART.toOrderItems();
    return `
    <div class="pscroll" id="pscroll">
      <div class="card">
        <div class="between"><span class="lbl">就餐方式</span>
          <span class="val">${st.diningType === 'takeout' ? '到店自取' : '堂食'}${st.tableNo ? ' · ' + esc(st.tableNo) : ''}</span></div>
        <div class="between mt-s"><span class="lbl">就餐人数</span><span class="val">${st.peopleCount} 人</span></div>
        <div class="between mt-s"><span class="lbl">锅底</span><span class="val">${st.soup ? esc(st.soup.name) : '未选择'}</span></div>
        <div class="between mt-s"><span class="lbl">蘸料</span>
          <span class="val ell">${st.dips.length ? esc(st.dips.map((d) => d.name).join('、')) : '未选择'}</span></div>
      </div>

      <div class="block-title">订单明细<span class="block-title__sub">共 ${sum.count} 件</span></div>
      <div class="card">
        ${items
          .map(
            (l) => `
          <div class="line">
            <div class="line__left">
              <div class="line__name ell">${esc(l.name)}</div>
              ${l.spicyName ? `<div class="line__spec">🌶 ${esc(l.spicyName)}</div>` : ''}
            </div>
            <div class="line__qty">×${l.count}</div>
            <div class="line__amount">¥${fen(l.amount)}</div>
          </div>`
          )
          .join('')}
      </div>

      <div class="block-title">优惠</div>
      <div class="card">
        <div class="between" style="cursor:pointer" onclick="A.pickCoupon()">
          <span class="lbl">优惠券</span>
          <span class="row">
            ${
              S.coupon
                ? `<span class="price">-¥${S.discountText} · ${esc(S.coupon.name)}</span>`
                : `<span class="muted">${S.usableCount ? S.usableCount + ' 张可用' : '暂无可用'}</span>`
            }
            <span style="color:#c8c8cd;font-size:15px;margin-left:6px">›</span>
          </span>
        </div>
      </div>

      <div class="block-title">口味备注</div>
      <div class="card"><div style="font-size:13px;color:#5c5c60;line-height:1.6">${esc(st.remark || '无')}</div></div>

      <div class="card amounts">
        <div class="between"><span class="muted">菜品小计</span><span>¥${sum.goodsText}</span></div>
        <div class="between mt-s"><span class="muted">锅底</span><span>¥${sum.soupFeeText}</span></div>
        ${sum.packFee ? `<div class="between mt-s"><span class="muted">打包费</span><span>¥${sum.packFeeText}</span></div>` : ''}
        ${Number(S.discountText) ? `<div class="between mt-s"><span class="muted">优惠券抵扣</span><span class="price">-¥${S.discountText}</span></div>` : ''}
        <div class="divider"></div>
        <div class="between"><span class="lbl">应付金额</span>
          <span class="price total"><span class="price__u">¥</span>${S.payText}</span></div>
      </div>
      <div style="padding:4px 16px 0;font-size:10.5px;color:#b8b8bd;line-height:1.6">
        下单即表示同意《点单服务协议》，请在 15 分钟内完成支付
      </div>
      <div class="holder"></div>
    </div>

    <div class="actionbar">
      <div class="actionbar__left">
        <div class="actionbar__label">实付</div>
        <div class="actionbar__amount"><span class="price__u">¥</span>${S.payText}</div>
      </div>
      <button class="btn-primary actionbar__btn ${S.submitting ? 'disabled' : ''}" onclick="A.submitOrder()">
        ${S.submitting ? '提交中…' : '提交订单'}
      </button>
    </div>`;
  }

  /* ---------------------------------------------------------- 页面：订单列表 */
  function screenOrders() {
    const list = S.orders;
    const body = list.length
      ? list
          .map(
            (o) => `
        <div class="order">
          <div class="order__head">
            <div class="order__shop ell">${esc(o.shopName)}</div>
            <div class="order__status" style="color:${o.statusColor}">${esc(o.statusText)}</div>
          </div>
          <div class="order__body" onclick="A.openDetail('${o.id}')">
            ${o.items.slice(0, 4).map((i) => `<div class="order__thumb">${i.emoji}</div>`).join('')}
            <div class="order__info">
              <div class="order__names ell2">${esc(o.summaryText)}</div>
              <div class="order__meta">${esc(o.diningTypeText)}${o.tableNo ? ' · ' + esc(o.tableNo) : ''} · ${o.itemCount} 件</div>
            </div>
          </div>
          <div class="order__foot">
            <div class="order__time">${esc(o.createDateText)}</div>
            <div class="order__pay">实付 <span class="order__amount">¥${o.amount.payText}</span></div>
          </div>
          <div class="order__actions">
            ${o.canCancel ? `<button class="btn-ghost" onclick="A.cancelOrder('${o.id}')">取消订单</button>` : ''}
            ${o.canPay ? `<button class="btn-primary" style="height:32px;font-size:13px;padding:0 16px" onclick="A.payOrder('${o.id}')">去支付</button>` : ''}
            ${o.canReorder ? `<button class="btn-ghost" onclick="A.reorder('${o.id}')">再来一单</button>` : ''}
            ${!o.canCancel && !o.canPay ? `<button class="btn-ghost" onclick="A.openDetail('${o.id}')">查看详情</button>` : ''}
          </div>
        </div>`
          )
          .join('') + '<div class="list-end">— 没有更多订单了 —</div>'
      : S.loading
      ? '<div style="text-align:center;padding:80px 0;color:#b8b8bd;font-size:13px">加载中…</div>'
      : `<div class="empty">
           <div class="empty__icon">🧾</div>
           <div class="empty__text">还没有订单，先去选几串吧</div>
           <div class="empty__btn" onclick="A.goTab('menu')">去点单</div>
         </div>`;

    return `
    <div class="tabs">
      ${ORDER.FILTERS.map(
        (f) => `
        <div class="tabs__item ${S.ordersFilter === f.key ? 'on' : ''}" onclick="A.setFilter('${f.key}')">
          ${f.name}
          ${S.ordersCounts[f.key] ? `<div class="tabs__badge">${S.ordersCounts[f.key]}</div>` : ''}
        </div>`
      ).join('')}
    </div>
    <div class="pscroll" id="pscroll">${body}<div style="height:16px"></div></div>`;
  }

  /* ---------------------------------------------------------- 页面：订单详情 */
  function screenOrderDetail() {
    const o = S.order;
    if (!o) return '<div style="text-align:center;padding:80px 0;color:#b8b8bd;font-size:13px">加载中…</div>';
    const showPickup = o.status !== 'UNPAID' && o.status !== 'CANCELED';
    return `
    <div class="pscroll" id="pscroll">
      <div class="banner" style="background:linear-gradient(150deg,${o.statusColor},${o.statusColor}cc)">
        <div class="banner__status">${esc(o.statusText)}</div>
        <div class="banner__desc">${esc(o.statusDesc)}</div>
        ${
          showPickup
            ? `<div class="banner__pickup">
                 <div class="banner__pickup-label">${o.diningType === 'takeout' ? '取餐码' : '桌号'}</div>
                 <div class="banner__pickup-no">${esc(o.diningType === 'takeout' ? o.pickupNo : o.tableNo)}</div>
                 <div class="banner__pickup-tip">${o.diningType === 'takeout' ? '请到取餐口报号取餐' : '菜品将送至该桌，请留意上菜'}</div>
               </div>`
            : ''
        }
      </div>

      ${
        o.timeline.length
          ? `<div class="card">
               <div class="block-title" style="padding:0;margin:0 0 10px">订单进度</div>
               <div class="tl">
                 ${o.timeline
                   .map(
                     (s, i) => `
                   <div class="tl__item ${s.done ? 'done' : ''} ${s.current ? 'cur' : ''}">
                     <div class="tl__axis">
                       <div class="tl__dot"></div>
                       ${i < o.timeline.length - 1 ? '<div class="tl__line"></div>' : ''}
                     </div>
                     <div class="tl__main">
                       <div class="tl__text">${esc(s.text)}</div>
                       <div class="tl__time">${esc(s.timeText || '等待中')}</div>
                     </div>
                   </div>`
                   )
                   .join('')}
               </div>
               ${S.polling ? '<div class="tl__hint">● 状态实时刷新中（每 5 秒）</div>' : ''}
             </div>`
          : ''
      }

      <div class="card">
        <div class="between"><span class="lbl">就餐方式</span>
          <span class="val">${esc(o.diningTypeText)}${o.tableNo ? ' · ' + esc(o.tableNo) : ''}</span></div>
        <div class="between mt-s"><span class="lbl">就餐人数</span><span class="val">${o.peopleCount} 人</span></div>
        <div class="between mt-s"><span class="lbl">锅底</span><span class="val">${esc(o.soupText)}</span></div>
        <div class="between mt-s"><span class="lbl">蘸料</span><span class="val ell">${esc(o.dipsText)}</span></div>
        <div class="between mt-s"><span class="lbl">口味备注</span><span class="val ell">${esc(o.remark || '无')}</span></div>
      </div>

      <div class="block-title">菜品明细<span class="block-title__sub">共 ${o.itemCount} 件</span></div>
      <div class="card">
        ${o.items
          .map(
            (l) => `
          <div class="line">
            <div class="line__icon">${l.emoji}</div>
            <div class="line__left">
              <div class="line__name ell">${esc(l.name)}</div>
              ${l.spicyName ? `<div class="line__spec">🌶 ${esc(l.spicyName)}</div>` : ''}
            </div>
            <div class="line__qty">×${l.count}</div>
            <div class="line__amount">¥${l.amountText}</div>
          </div>`
          )
          .join('')}
        <div class="divider"></div>
        <div class="between"><span class="muted">菜品小计</span><span>¥${o.amount.goodsText}</span></div>
        <div class="between mt-s"><span class="muted">锅底</span><span>¥${o.amount.soupFeeText}</span></div>
        ${o.amount.packFee ? `<div class="between mt-s"><span class="muted">打包费</span><span>¥${o.amount.packFeeText}</span></div>` : ''}
        ${o.amount.discount ? `<div class="between mt-s"><span class="muted">优惠券抵扣</span><span class="price">-¥${o.amount.discountText}</span></div>` : ''}
        <div class="divider"></div>
        <div class="between"><span class="lbl">实付金额</span>
          <span class="price total"><span class="price__u">¥</span>${o.amount.payText}</span></div>
      </div>

      <div class="card">
        <div class="between"><span class="muted">订单号</span>
          <span class="row"><span class="val">${esc(o.orderNo)}</span>
            <span class="copy" onclick="A.copyOrderNo()">复制</span></span></div>
        <div class="between mt-s"><span class="muted">下单时间</span><span class="val">${esc(o.createDateText)}</span></div>
        <div class="between mt-s"><span class="muted">门店</span><span class="val ell">${esc(o.shopName)}</span></div>
      </div>
      <div class="holder"></div>
    </div>

    <div class="actionbar">
      <button class="btn-ghost" onclick="A.callShop()">联系门店</button>
      ${o.canCancel ? `<button class="btn-ghost" onclick="A.cancelOrder('${o.id}')">取消订单</button>` : ''}
      ${o.canReorder ? `<button class="btn-ghost" onclick="A.reorder('${o.id}')">再来一单</button>` : ''}
      ${o.canFinish ? `<button class="btn-ghost" onclick="A.finishOrder('${o.id}')">确认完成</button>` : ''}
      ${
        o.canPay
          ? `<button class="btn-primary" style="flex:1" onclick="A.payOrder('${o.id}')">立即支付 ¥${o.amount.payText}</button>`
          : ''
      }
    </div>`;
  }

  /* ---------------------------------------------------------- 页面：我的 */
  function screenMine() {
    const u = S.user || {};
    const shop = (S.menu && S.menu.shop) || {};
    return `
    <div class="ucard">
      <div class="ucard__avatar" onclick="A.pickAvatar()">
        ${u.avatar ? `<img src="${esc(u.avatar)}" style="width:64px;height:64px;border-radius:50%;object-fit:cover">` : '🌶️'}
        <div class="ucard__camera">📷</div>
      </div>
      <div class="ucard__main">
        <input class="ucard__nick" id="nick" value="${esc(u.nickname || '')}" placeholder="点击设置昵称" maxlength="16">
        <div class="ucard__sub">
          <span class="ucard__level">${esc(u.memberName || '铜签会员')}</span>
          <span class="ucard__points">成长值 ${u.points || 0}</span>
        </div>
      </div>
      <button class="btn-primary" style="height:30px;font-size:12px;padding:0 14px" onclick="A.saveProfile()">保存</button>
    </div>

    <div class="stats">
      <div class="stats__item" onclick="A.goTab('orders')">
        <div class="stats__num">${S.stats.orderCount}</div>
        <div class="stats__label">我的订单</div>
      </div>
      <div class="stats__line"></div>
      <div class="stats__item" onclick="A.pickCoupon(true)">
        <div class="stats__num">${S.stats.couponCount}</div>
        <div class="stats__label">优惠券</div>
      </div>
      <div class="stats__line"></div>
      <div class="stats__item" onclick="A.pointsRule()">
        <div class="stats__num">${u.points || 0}</div>
        <div class="stats__label">积分</div>
      </div>
    </div>

    <div class="pscroll" id="pscroll">
      <div class="card">
        <div class="menu-list">
          <div class="menu__item" onclick="A.goTab('orders')">
            <span class="menu__icon">🧾</span><span class="menu__text">我的订单</span>
            ${S.stats.ongoingCount ? `<span class="menu__tip">${S.stats.ongoingCount} 单进行中</span>` : ''}
            <span class="menu__arrow">›</span>
          </div>
          <div class="menu__item" onclick="A.pickCoupon(true)">
            <span class="menu__icon">🎟️</span><span class="menu__text">优惠券中心</span>
            <span class="menu__arrow">›</span>
          </div>
          <div class="menu__item" onclick="A.callShop()">
            <span class="menu__icon">☎️</span><span class="menu__text">联系门店</span>
            <span class="menu__arrow">›</span>
          </div>
          <div class="menu__item" onclick="A.openLocation()">
            <span class="menu__icon">📍</span><span class="menu__text">门店地址</span>
            <span class="menu__tip ell">${esc(shop.address || '')}</span>
            <span class="menu__arrow">›</span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="menu-list">
          <!-- 手机号：与小程序一致 —— 微信登录只返回 openid，拿不到手机号，必须由用户点一次
               getPhoneNumber 授权；绑定后同一个入口即「更换」，服务端覆盖，无需先解绑 -->
          <div class="menu__item" onclick="A.bindPhone()">
            <span class="menu__icon">📱</span>
            <span class="menu__text">${u.phoneBound || u.phoneMask ? '手机号' : '绑定手机号'}</span>
            <span class="menu__tip">${u.phoneBound || u.phoneMask ? esc(u.phoneMask) + ' · 更换' : '微信一键授权，免填号码'}</span>
            <span class="menu__arrow">›</span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="menu-list">
          <div class="menu__item" onclick="A.about()">
            <span class="menu__icon">ℹ️</span><span class="menu__text">关于我们</span>
            <span class="menu__tip">v1.0.0</span><span class="menu__arrow">›</span>
          </div>
          <div class="menu__item" onclick="A.resetLocal()">
            <span class="menu__icon">🧹</span><span class="menu__text">清除本地缓存</span>
            <span class="menu__arrow">›</span>
          </div>
        </div>
      </div>

      <div class="footer">
        <div class="footer__line">老北京麻辣串串香 · 现串现涮</div>
        <div class="footer__sub">${esc(shop.openTime || '')}</div>
      </div>
      <div class="holder" style="height:20px"></div>
    </div>`;
  }

  /* ---------------------------------------------------------- 联动测量 */
  function measureSections() {
    const cats = (S.menu && S.menu.categories) || [];
    const box = $('#dishes');
    if (!cats.length || !box) return;
    const base = box.getBoundingClientRect().top - box.scrollTop;
    S.sectionTops = cats.map((c) => {
      const el = document.getElementById('sec-' + c.id);
      return { id: c.id, top: el ? el.getBoundingClientRect().top - base : 0 };
    });
  }

  let scrollTicking = false;
  function onDishScroll() {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      scrollTicking = false;
      if (S.lockSync) return;
      const box = $('#dishes');
      if (!box || !S.sectionTops.length) return;
      const st = box.scrollTop;
      let active = S.sectionTops[0].id;
      S.sectionTops.forEach((s) => {
        if (st + 3 >= s.top) active = s.id;
      });
      if (active === S.activeCat) return;
      S.activeCat = active;
      $$('.cat').forEach((el) => el.classList.toggle('on', el.id === 'cat-' + active));
      const cur = document.getElementById('cat-' + active);
      const catsBox = $('#cats');
      if (cur && catsBox) {
        const top = cur.offsetTop;
        if (top < catsBox.scrollTop || top + cur.offsetHeight > catsBox.scrollTop + catsBox.clientHeight) {
          catsBox.scrollTop = top - catsBox.clientHeight / 2 + cur.offsetHeight / 2;
        }
      }
    });
  }

  function tapCat(id) {
    S.activeCat = id;
    S.lockSync = true;
    $$('.cat').forEach((el) => el.classList.toggle('on', el.id === 'cat-' + id));
    const sec = document.getElementById('sec-' + id);
    const box = $('#dishes');
    if (sec && box) box.scrollTo({ top: sec.offsetTop - 0, behavior: 'smooth' });
    const cur = document.getElementById('cat-' + id);
    const catsBox = $('#cats');
    if (cur && catsBox) {
      catsBox.scrollTo({ top: cur.offsetTop - catsBox.clientHeight / 2 + cur.offsetHeight / 2, behavior: 'smooth' });
    }
    clearTimeout(S._lock);
    S._lock = setTimeout(() => {
      S.lockSync = false;
    }, 460);
  }

  /* ---------------------------------------------------------- 购物车同步 */
  function syncCart() {
    const st = CART.get();
    S.cartSummary = CART.getSummary();
    S.countMap = {};
    S.catCount = {};
    st.items.forEach((i) => {
      S.countMap[i.dishId] = (S.countMap[i.dishId] || 0) + i.count;
      const cid = S.dishCategory[i.dishId];
      if (cid) S.catCount[cid] = (S.catCount[cid] || 0) + i.count;
    });
    S.diningType = st.diningType;
    S.tableNo = st.tableNo;
    S.cartItems = st.items.map((i) => Object.assign({}, i, { priceText: fen(i.price) }));
    S.dipChecked = {};
    st.dips.forEach((d) => {
      S.dipChecked[d.id] = true;
    });

    if (S.screen === 'menu' && S.menu) syncMenuDom();
    else if (S.screen === 'cart') render();
    else $('#tabbar-root').innerHTML = tabbarHtml();
    if (S.screen === 'menu') $('#tabbar-root').innerHTML = tabbarHtml();
  }

  function syncMenuDom() {
    const bar = $('.cartbar');
    if (bar) bar.outerHTML = cartbarHtml();
    S.menu.categories.forEach((cat) => {
      const el = document.getElementById('cat-' + cat.id);
      if (el) {
        let b = el.querySelector('.cat__badge');
        const n = S.catCount[cat.id];
        if (n) {
          if (!b) {
            b = document.createElement('div');
            b.className = 'cat__badge';
            el.appendChild(b);
          }
          b.textContent = n;
        } else if (b) {
          b.remove();
        }
      }
      cat.dishes.forEach((d) => {
        const holder = document.getElementById('ctl-' + d.id);
        if (holder) holder.innerHTML = dishControl(d, S.countMap[d.id] || 0);
      });
    });
  }

  /* ---------------------------------------------------------- 结算金额 */
  function recalcCoupon() {
    const sum = CART.getSummary();
    const base = sum.goodsAmount + sum.soupFee;
    const usable = S.coupons.filter((c) => base >= c.threshold);
    // 券失效则自动摘掉
    if (S.coupon && (!S.coupons.some((c) => c.id === S.coupon.id) || base < S.coupon.threshold)) {
      S.coupon = null;
    }
    const discount = MOCK_COUPON.calcDiscount(S.coupon, sum);
    S.discountText = fen(discount);
    S.usableCount = usable.length;
    S.payText = fen(Math.max(0, sum.total - discount));
  }

  /* ---------------------------------------------------------- Actions */
  const A = {
    /* --- 导航 --- */
    goTab(key) {
      if (key === 'cart' && !S.cartSummary.count) {
        UI.toast('还没选串，点「+」开始吧');
        return;
      }
      S.screen = key;
      if (key === 'orders') A.loadOrders();
      if (key === 'mine') A.loadStats();
      if (key === 'cart') recalcCoupon();
      render();
    },
    back() {
      if (S.screen === 'order-detail') S.screen = S.fromScreen || 'orders';
      else if (S.screen === 'confirm') S.screen = 'cart';
      if (S.screen === 'orders') A.loadOrders();
      render();
    },

    /* --- 点单页 --- */
    tapCat,
    onDishScroll,
    setDining(v) {
      CART.setDiningType(v);
      if (v === 'dinein' && !CART.get().tableNo && S.tables.length) CART.setTableNo(S.tables[0]);
      render();
    },
    setTable(v) {
      CART.setTableNo(v);
      render();
    },
    addDish(id) {
      const d = S.dishMap[id];
      if (!d) return;
      if (d.spicy) {
        const opts = d.spicyOptions || [];
        const last = CART.getLastSpec(d.id);
        S.skuDish = d;
        S.skuSpicy = opts.some((o) => o.id === last) ? last : (opts[1] || opts[0] || {}).id;
        S.skuCount = 1;
        S.skuShow = true;
        renderSku();
        return;
      }
      CART.add(d, null, 1);
      UI.toast('已加入：' + d.name);
    },
    dishStep(id, delta) {
      const d = S.dishMap[id];
      if (!d) return;
      const cur = CART.getDishCount(id);
      const next = cur + delta;
      if (next > d.stock) {
        UI.toast('已达可点上限');
        return;
      }
      if (delta > 0) CART.add(d, null, delta);
      else CART.reduceDish(id, Math.min(-delta, cur));
    },

    /* --- 规格弹层 --- */
    skuPick(id) {
      S.skuSpicy = id;
      renderSku();
    },
    skuCount(delta) {
      S.skuCount = Math.max(1, Math.min(S.skuDish.stock, S.skuCount + delta));
      renderSku();
    },
    skuClose() {
      S.skuShow = false;
      renderSku();
    },
    skuConfirm() {
      const d = S.skuDish;
      const opt = (d.spicyOptions || []).find((o) => o.id === S.skuSpicy);
      if (!opt) {
        UI.toast('请选择辣度');
        return;
      }
      CART.add(d, { spicyId: opt.id, spicyName: opt.name }, S.skuCount);
      S.skuShow = false;
      renderSku();
      UI.toast(`${d.name} · ${opt.name} ×${S.skuCount}`);
    },

    /* --- 购物车 --- */
    pickSoup(id) {
      const s = ((S.menu && S.menu.soups) || []).find((x) => x.id === id);
      if (s) CART.setSoup(s);
    },
    toggleDip(id, name) {
      CART.toggleDip({ id, name });
    },
    itemStep(key, delta) {
      const it = CART.get().items.find((i) => i.key === key);
      if (!it) return;
      CART.setCount(key, it.count + delta);
    },
    delItem(key) {
      const it = CART.get().items.find((i) => i.key === key);
      UI.modal({ title: '提示', content: `确定删除「${it ? it.name : ''}」吗？` }, (r) => {
        if (r.confirm) CART.remove(key);
      });
    },
    clearItems() {
      UI.modal({ title: '提示', content: '确定清空购物车全部菜品吗？' }, (r) => {
        if (r.confirm) {
          CART.clear(false);
          UI.toast('已清空');
        }
      });
    },
    people(delta) {
      CART.setPeopleCount(CART.get().peopleCount + delta);
      render();
    },
    remarkChange(v) {
      CART.setRemark(v);
      const c = $('.remark__count');
      if (c) c.textContent = (v || '').length + '/100';
    },
    goConfirm() {
      const sum = CART.getSummary();
      if (!sum.canSubmit) {
        UI.toast(blockReason(sum, CART.get()) || '请完善订单信息');
        return;
      }
      recalcCoupon();
      S.screen = 'confirm';
      render();
    },

    /* --- 优惠券 --- */
    pickCoupon(browseOnly) {
      const sum = CART.getSummary();
      const base = sum.goodsAmount + sum.soupFee;
      const opts = [{ label: '不使用优惠券', right: '', disabled: false, coupon: null }].concat(
        S.coupons.map((c) => ({
          label: `${c.name}（${c.threshold ? '满 ' + fen(c.threshold) : '无门槛'}）${c.scope ? ' · ' + c.scope : ''}`,
          right: base >= c.threshold ? '-¥' + fen(Math.min(c.value, base)) : '不可用',
          disabled: base < c.threshold,
          coupon: c,
        }))
      );
      UI.picker('选择优惠券', opts, (o) => {
        if (browseOnly) {
          UI.toast(o.coupon ? '已选择，去点单页下单可用' : '已关闭');
          return;
        }
        S.coupon = o.coupon;
        recalcCoupon();
        render();
      });
    },

    /* --- 提交与支付 --- */
    submitOrder() {
      if (S.submitting) return;
      const st = CART.get();
      const sum = CART.getSummary();
      const discount = Math.round(Number(S.discountText) * 100);
      S.submitting = true;
      render();
      UI.loading('提交中');

      ORDER.createOrder({
        items: CART.toOrderItems(),
        soup: st.soup,
        dips: st.dips,
        diningType: st.diningType,
        tableNo: st.tableNo,
        peopleCount: st.peopleCount,
        remark: st.remark,
        coupon: S.coupon,
        amount: {
          goods: sum.goodsAmount,
          soupFee: sum.soupFee,
          packFee: sum.packFee,
          discount,
          pay: Math.max(0, sum.total - discount),
        },
      })
        .then((order) => {
          UI.loadingHide();
          A._payFlow(order);
        })
        .catch((e) => {
          UI.loadingHide();
          S.submitting = false;
          render();
          UI.toast((e && e.message) || '提交订单失败');
        });
    },

    _payFlow(order) {
      UI.modal(
        {
          title: '模拟支付',
          content: `应付 ¥${fen(order.amount.pay)}\n（当前为本地 Mock，未接入商户号）`,
          confirmText: '确认支付',
          cancelText: '取消',
        },
        (r) => {
          if (r.confirm) A._doPay(order);
          else A._afterUnpaid(order, '你取消了支付');
        }
      );
    },

    _doPay(order) {
      UI.loading('支付中');
      ORDER.payOrder(order.id)
        .then((paid) => {
          UI.loadingHide();
          CART.clear(false);
          S.submitting = false;
          UI.toast('支付成功');
          S.fromScreen = 'menu';
          setTimeout(() => A.openDetail(paid.id), 500);
        })
        .catch((e) => {
          UI.loadingHide();
          S.submitting = false;
          render();
          if (e && e.code === 'CANCEL') return A._afterUnpaid(order, '你取消了支付');
          UI.toast((e && e.message) || '支付失败');
        });
    },

    _afterUnpaid(order, reason) {
      S.submitting = false;
      render();
      UI.modal(
        {
          title: '订单已生成',
          content: `${reason}，订单已保存 15 分钟，可在「订单」中继续支付`,
          showCancel: false,
          confirmText: '查看订单',
        },
        () => A.openDetail(order.id)
      );
    },

    /* --- 订单 --- */
    loadOrders() {
      S.loading = true;
      return ORDER.listOrders(S.ordersFilter).then((list) => {
        S.orders = list;
        S.loading = false;
        S.ordersCounts =
          S.ordersFilter === 'all'
            ? { ongoing: list.filter((o) => ORDER.isOngoing(o.status)).length }
            : {};
        if (S.screen === 'orders') render();
      });
    },
    setFilter(key) {
      S.ordersFilter = key;
      A.loadOrders().then(render);
    },
    openDetail(id) {
      if (S.screen !== 'order-detail') S.fromScreen = S.screen;
      S.screen = 'order-detail';
      S.order = null;
      render();
      ORDER.getOrder(id).then((o) => {
        S.order = o;
        render();
        A._syncPoll(o);
      });
      if (S.detailTimer) {
        clearInterval(S.detailTimer);
        S.detailTimer = null;
      }
    },
    _syncPoll(o) {
      const need = ORDER.isOngoing(o.status) && o.status !== ORDER.STATUS.UNPAID;
      if (need && !S.detailTimer) {
        S.polling = true;
        S.detailTimer = setInterval(() => {
          const fresh = ORDER.refreshStatus(o.id);
          if (!fresh) return;
          S.order = fresh;
          if (S.screen === 'order-detail') render();
          if (!ORDER.isOngoing(fresh.status)) {
            clearInterval(S.detailTimer);
            S.detailTimer = null;
            S.polling = false;
          }
        }, 5000);
      } else if (!need && S.detailTimer) {
        clearInterval(S.detailTimer);
        S.detailTimer = null;
        S.polling = false;
      }
    },
    payOrder(id) {
      UI.modal(
        { title: '模拟支付', content: '确认支付这笔订单？', confirmText: '确认支付' },
        (r) => {
          if (!r.confirm) return;
          UI.loading('支付中');
          ORDER.payOrder(id)
            .then(() => {
              UI.loadingHide();
              UI.toast('支付成功');
              A.refreshCurrent();
            })
            .catch((e) => {
              UI.loadingHide();
              UI.toast((e && e.message) || '支付失败');
            });
        }
      );
    },
    cancelOrder(id) {
      UI.modal({ title: '提示', content: '确定取消这笔订单吗？' }, (r) => {
        if (!r.confirm) return;
        ORDER.cancelOrder(id, '用户主动取消')
          .then(() => {
            UI.toast('已取消');
            A.refreshCurrent();
          })
          .catch(() => UI.toast('取消失败'));
      });
    },
    finishOrder(id) {
      ORDER.finishOrder(id).then((o) => {
        S.order = o;
        render();
        UI.toast('已确认完成');
      });
    },
    reorder(id) {
      ORDER.reorder(id).then(() => {
        UI.toast('已加入购物车');
        setTimeout(() => A.goTab('cart'), 400);
      });
    },
    refreshCurrent() {
      if (S.screen === 'orders') {
        A.loadOrders();
      } else if (S.screen === 'order-detail' && S.order) {
        ORDER.getOrder(S.order.id).then((o) => {
          S.order = o;
          render();
          A._syncPoll(o);
        });
      } else {
        render();
      }
    },
    copyOrderNo() {
      const no = S.order && S.order.orderNo;
      if (!no) return;
      try {
        navigator.clipboard.writeText(no);
      } catch (e) {}
      UI.toast('订单号已复制：' + no);
    },
    callShop() {
      UI.toast('已模拟拨打 010-8888 6666');
    },

    /* --- 我的 --- */
    loadStats() {
      return ORDER.listOrders('all').then((list) => {
        S.stats = {
          orderCount: list.length,
          ongoingCount: list.filter((o) => ORDER.isOngoing(o.status)).length,
          couponCount: S.coupons.length,
        };
        if (S.screen === 'mine') render();
      });
    },
    pickAvatar() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => {
        const f = input.files && input.files[0];
        if (!f) return;
        const fr = new FileReader();
        fr.onload = () => {
          AUTH.updateProfile({ avatar: fr.result }).then((u) => {
            S.user = u;
            render();
            UI.toast('头像已更新');
          });
        };
        fr.readAsDataURL(f);
      };
      input.click();
    },
    saveProfile() {
      const nick = ($('#nick') && $('#nick').value.trim()) || '';
      if (!nick) {
        UI.toast('先填一个昵称');
        return;
      }
      AUTH.updateProfile({ nickname: nick }).then((u) => {
        S.user = u;
        render();
        UI.toast('已保存');
      });
    },
    pointsRule() {
      UI.modal({
        title: '积分说明',
        content: '消费 1 元累计 1 积分，100 积分可抵 1 元。积分在订单完成后 1 分钟到账。',
        showCancel: false,
      });
    },
    about() {
      UI.modal({
        title: '关于我们',
        content: '老北京麻辣串串香 · 点单小程序 v1.0.0\n\n现串现涮，人均约 ¥68\n营业时间：11:00 - 次日 02:00',
        showCancel: false,
      });
    },
    openLocation() {
      UI.toast('已模拟打开地图：东直门内大街 188 号');
    },
    /**
     * 手机号绑定 / 更换（对应小程序的 getPhoneNumber 一键授权）
     * 预览版没有微信原生授权面板，用确认弹窗模拟用户点「允许」这一步；
     * 已绑定时同一入口走「更换」分支 —— 与小程序一致，绑一次即可，之后随时换号。
     */
    bindPhone() {
      const bound = !!(S.user && (S.user.phoneBound || S.user.phoneMask));
      UI.modal(
        {
          title: bound ? '更换手机号' : '绑定手机号',
          content: bound
            ? '将重新唤起微信「手机号快速验证」，新号码直接覆盖原号码，无需先解绑。'
            : '将唤起微信「手机号快速验证」组件，用户点一次授权即可，无需手动输入号码。',
          confirmText: bound ? '更换' : '允许',
        },
        (r) => {
          if (!r.confirm) {
            UI.toast('已取消手机号授权');
            return;
          }
          AUTH.bindPhone({}).then((res) => {
            S.user = Object.assign({}, S.user, { phoneMask: res.phoneMask, phoneBound: true });
            render();
            UI.toast((bound ? '已更换为 ' : '已绑定 ') + res.phoneMask);
          });
        }
      );
    },
    resetLocal() {
      UI.modal({ title: '提示', content: '将清空本地购物车、订单记录与登录态，确定继续？' }, (r) => {
        if (!r.confirm) return;
        CART.clearAll();
        wx.removeStorageSync('lbz_orders_v1');
        wx.removeStorageSync('lbz_pickup_seq');
        AUTH.logout();
        S.orders = [];
        S.order = null;
        S.stats = { orderCount: 0, ongoingCount: 0, couponCount: S.coupons.length };
        render();
        UI.toast('已清空本地数据');
      });
    },
  };
  window.A = A;

  /* ---------------------------------------------------------- 启动 */
  function boot() {
    // 1) 登录（复用 utils/auth.js 的静默登录）
    AUTH.ensureLogin()
      .then((u) => {
        S.user = u;
      })
      .catch(() => {});

    // 2) 优惠券（复用 mock/coupon.js）
    S.coupons = MOCK_COUPON.COUPONS;

    // 3) 购物车订阅（先订阅一次拿到初始态）
    CART.subscribe(() => syncCart());

    // 4) 菜单（复用 services/menu.js，含 60s 内存缓存）
    MENU_SVC.getMenu()
      .then((menu) => {
        menu.categories.forEach((c) =>
          c.dishes.forEach((d) => {
            S.dishMap[d.id] = d;
            S.dishCategory[d.id] = c.id;
          })
        );
        S.menu = menu;
        S.tables = menu.shop.tables || [];
        S.loading = false;
        const st = CART.get();
        if (!st.soup && menu.soups.length) CART.setSoup(menu.soups[0]);
        if (st.diningType === 'dinein' && !st.tableNo && S.tables.length) CART.setTableNo(S.tables[0]);
        S.activeCat = menu.categories[0].id;
        syncCart();
        render();
        A.loadStats();
      })
      .catch((e) => {
        S.loading = false;
        render();
        UI.toast('菜单加载失败：' + ((e && e.message) || e));
      });

    render();
    setTimeout(() => A.loadOrders(), 0);
  }

  /* 自适应缩放：保证在预览面板里能完整看到手机 */
  function fit() {
    const el = $('.phone');
    if (!el) return;
    const s = Math.min(1, (window.innerHeight - 24) / 812, (window.innerWidth - 380) / 375);
    el.style.transform = s < 1 ? `scale(${Math.max(0.62, s)})` : 'none';
  }
  window.addEventListener('resize', fit);

  document.addEventListener('DOMContentLoaded', () => {
    fit();
    boot();
  });
  if (document.readyState !== 'loading') {
    fit();
    boot();
  }
})();
