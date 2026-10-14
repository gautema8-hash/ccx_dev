/**
 * 菜单服务层
 * - 页面只依赖这一层，不直接碰 mock / 网络
 * - 内置 60s 内存缓存（挂在 App.globalData.menuCache），避免切 tab 重复请求
 * - 价格在服务层统一补 priceText，页面模板零计算
 * - 辣度字典以**服务端返回的**为准（真实后端下不能再依赖本地 mock）
 */
const config = require('../utils/config');
const { request } = require('../utils/request');
const mock = require('../mock/menu');
const cart = require('../utils/cart');

const CACHE_TTL = 60 * 1000;

/** 本地兜底字典：仅在服务端未返回时使用 */
const FALLBACK_SPICY = mock.SPICY_OPTIONS;

function decorateDish(dish, spicyOptions) {
  return Object.assign({}, dish, {
    priceText: (dish.price / 100).toFixed(2),
    spicyOptions: dish.spicy ? spicyOptions : [],
    /** 售罄：列表置灰、不可加购 */
    soldOut: dish.soldOut === true || Number(dish.stock) <= 0,
  });
}

const withPrice = (x) => Object.assign({}, x, { priceText: (x.price / 100).toFixed(2) });

/** 全量菜单：门店 + 分类（内含菜品）+ 锅底 + 蘸料 + 辣度字典（连锁：按门店出菜单与库存） */
function getMenu(force, storeId) {
  const app = getApp();
  const cached = app && app.globalData.menuCache;
  /* 缓存按门店隔离：换门店必须重新拉，否则会串菜单 */
  const sameStore = cached && cached.storeId === (storeId || '');
  if (!force && cached && sameStore && Date.now() - cached.ts < CACHE_TTL) {
    return Promise.resolve(cached.data);
  }

  const task = config.USE_MOCK
    ? new Promise((resolve) => {
        setTimeout(() => {
          const spicyOptions = FALLBACK_SPICY;
          resolve({
            shop: mock.SHOP,
            categories: mock.CATEGORIES.map((c) =>
              Object.assign({}, c, {
                dishes: mock.DISHES.filter((d) => d.categoryId === c.id).map((d) => decorateDish(d, spicyOptions)),
              })
            ),
            soups: mock.SOUPS.map(withPrice),
            dips: mock.DIPS.map(withPrice),
            spicyOptions,
            totalDishes: mock.DISHES.length,
            store: Object.assign({}, mock.SHOP, { type: 'DIRECT', typeText: '直营店' }),
            brand: { name: '老北京麻辣烫串串香（集团）' },
          });
        }, 180);
      })
    : request({ url: '/menu', method: 'GET', data: { storeId: storeId || '' }, idempotent: true }).then((data) => {
        const spicyOptions =
          Array.isArray(data.spicyOptions) && data.spicyOptions.length ? data.spicyOptions : FALLBACK_SPICY;
        return {
          shop: data.shop || {},
          store: data.store || data.shop || {},
          brand: data.brand || {},
          categories: (data.categories || []).map((c) =>
            Object.assign({}, c, {
              dishes: (c.dishes || []).map((d) => decorateDish(d, spicyOptions)),
            })
          ),
          soups: (data.soups || []).map(withPrice),
          dips: (data.dips || []).map(withPrice),
          spicyOptions,
          totalDishes: data.totalDishes || 0,
        };
      });

  return task.then((data) => {
    if (app) app.globalData.menuCache = { ts: Date.now(), storeId: storeId || '', data };
    /* 打包费以服务端下发的为准，避免客户端写死导致「页面显示与实付不一致」 */
    if (data && data.packFee !== undefined) cart.setPackFee(data.packFee);
    return data;
  });
}

/** 清缓存（下拉刷新 / 商家改价后） */
function clearCache() {
  const app = getApp();
  if (app) app.globalData.menuCache = null;
}

/** 菜品详情（分享落地页用） */
function getDish(id) {
  return getMenu().then((menu) => {
    let found = null;
    menu.categories.forEach((c) => {
      c.dishes.forEach((d) => {
        if (d.id === id) found = d;
      });
    });
    return found;
  });
}

/**
 * 本地搜索：菜单已在内存里，直接过滤最快（无需网络往返）
 * 命中「菜名 / 描述 / 标签」
 */
function searchMenu(menu, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw || !menu) return null;
  const hits = [];
  menu.categories.forEach((c) => {
    c.dishes.forEach((d) => {
      const hay = (d.name + ' ' + (d.desc || '') + ' ' + (d.tags || []).join(' ')).toLowerCase();
      if (hay.indexOf(kw) > -1) hits.push(d);
    });
  });
  return hits;
}

module.exports = { getMenu, getDish, clearCache, searchMenu, SPICY_OPTIONS: FALLBACK_SPICY };
