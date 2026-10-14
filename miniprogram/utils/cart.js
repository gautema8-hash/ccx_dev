/**
 * 购物车（本地状态中心）
 *
 * 设计要点：
 * 1. 单一数据源 + 发布订阅：任何页面改动购物车，其余页面通过 subscribe 自动同步，避免手工传参。
 * 2. 本地持久化：落地到 wx.setStorageSync，杀进程重进不丢购物车。
 * 3. 同一菜品不同「辣度」算两条明细，行唯一键 key = dishId#spicyId。
 * 4. 金额一律用「分」做整数运算，杜绝浮点误差。
 */
const { fen2yuan } = require('./util');

const KEY = 'lbz_cart_v1';
const listeners = [];
let state = null;

function blank() {
  return {
    version: 1,
    items: [], // { key, dishId, name, emoji, price, unit, count, spicyId, spicyName, desc }
    soup: null, // { id, name, price }  锅底（订单级必选）
    dips: [], // [{ id, name }]        蘸料（订单级多选，免费）
    diningType: 'dinein', // dinein 堂食 | takeout 自取
    tableNo: '',
    peopleCount: 2,
    remark: '',
    /** 打包费（分）。由服务端 /menu 下发后写入，避免客户端写死导致展示金额与实付不符 */
    packFee: 100,
    /** 最近一次选择的规格，用于快捷加购时的默认值 */
    lastSpec: {}, // { [dishId]: spicyId }
  };
}

function get() {
  if (!state) {
    const cached = wx.getStorageSync(KEY);
    state = cached && cached.version === 1 ? cached : blank();
  }
  return state;
}

function persist() {
  wx.setStorageSync(KEY, state);
  notify();
}

function notify() {
  const summary = getSummary();
  listeners.forEach((fn) => {
    try {
      fn(summary);
    } catch (e) {
      console.error('[cart] listener error', e);
    }
  });
}

function subscribe(fn) {
  listeners.push(fn);
  try {
    fn(getSummary());
  } catch (e) {}
  return () => {
    const i = listeners.indexOf(fn);
    if (i > -1) listeners.splice(i, 1);
  };
}

function makeKey(dishId, spicyId) {
  return dishId + '#' + (spicyId || 'none');
}

/* ------------------------------ 明细操作 ------------------------------ */

/**
 * 加入购物车
 * @param {object} dish  菜品对象（含 id/name/price/unit/emoji/desc）
 * @param {{spicyId?:string, spicyName?:string}} spec
 * @param {number} count
 */
function add(dish, spec, count) {
  const s = get();
  const spicyId = (spec && spec.spicyId) || '';
  const spicyName = (spec && spec.spicyName) || '';
  const key = makeKey(dish.id, spicyId);
  // 上限取「库存」与 99 的较小值：规格弹层反复加购也要挡住超卖
  const stock = Number(dish.stock);
  const cap = Math.min(99, stock > 0 ? stock : 99);
  const addNum = Math.max(1, Number(count) || 1);
  const exist = s.items.find((i) => i.key === key);
  if (exist) {
    if (exist.count >= cap) return key;
    exist.count = Math.min(cap, exist.count + addNum);
  } else {
    s.items.push({
      key,
      dishId: dish.id,
      name: dish.name,
      emoji: dish.emoji || '🍢',
      price: dish.price,
      unit: dish.unit || '份',
      count: Math.min(cap, addNum),
      spicyId,
      spicyName,
      desc: dish.desc || '',
    });
  }
  if (spicyId) s.lastSpec[dish.id] = spicyId;
  persist();
  return key;
}

/** 直接设置某行数量，count<=0 自动移除 */
function setCount(key, count) {
  const s = get();
  const idx = s.items.findIndex((i) => i.key === key);
  if (idx === -1) return;
  if (count <= 0) {
    s.items.splice(idx, 1);
  } else {
    s.items[idx].count = Math.min(99, count);
  }
  persist();
}

function remove(key) {
  setCount(key, 0);
}

/**
 * 按菜品维度扣减数量（从最后加入的明细往前扣）
 * 用于点单列表页「无规格菜品」的步进器减号
 */
function reduceDish(dishId, n) {
  const s = get();
  let left = n;
  for (let i = s.items.length - 1; i >= 0 && left > 0; i--) {
    const it = s.items[i];
    if (it.dishId !== dishId) continue;
    const cut = Math.min(it.count, left);
    it.count -= cut;
    left -= cut;
    if (it.count <= 0) s.items.splice(i, 1);
  }
  persist();
}

function clear(full) {
  const s = get();
  const keep = {
    soup: s.soup,
    dips: s.dips,
    diningType: s.diningType,
    tableNo: s.tableNo,
    peopleCount: s.peopleCount,
    remark: s.remark,
    lastSpec: s.lastSpec,
  };
  state = blank();
  if (!full) Object.assign(state, keep);
  persist();
}

function clearAll() {
  clear(true);
}

/* ------------------------------ 订单级选项 ------------------------------ */

function setSoup(soup) {
  get().soup = soup ? { id: soup.id, name: soup.name, price: soup.price } : null;
  persist();
}

function toggleDip(dip) {
  const s = get();
  const i = s.dips.findIndex((d) => d.id === dip.id);
  if (i > -1) s.dips.splice(i, 1);
  else s.dips.push({ id: dip.id, name: dip.name });
  persist();
}

function setDiningType(type) {
  get().diningType = type;
  if (type === 'takeout') get().tableNo = '';
  persist();
}

function setTableNo(no) {
  get().tableNo = (no || '').slice(0, 10);
  persist();
}

function setPeopleCount(n) {
  get().peopleCount = Math.max(1, Math.min(20, Number(n) || 1));
  persist();
}

function setRemark(text) {
  get().remark = (text || '').slice(0, 100);
  persist();
}

/**
 * 按「当前门店的菜单」校正购物车
 *
 * 切换门店后购物车里仍是上一家店的价格与本店可能已停售的菜品，
 * 不校正就会出现「页面显示 ¥20、提交后实付 ¥22」，或下单时报「本店已停售」。
 *
 * @param {object} dishMap { dishId: {price, name, stock} }
 * @returns {{removed:number, changed:number, capped:number}}
 */
function reprice(dishMap) {
  if (!dishMap || !Object.keys(dishMap).length) return { removed: 0, changed: 0, capped: 0 };
  const s = get();
  let removed = 0;
  let changed = 0;
  let capped = 0;
  s.items = s.items.filter((i) => {
    const d = dishMap[i.dishId];
    /* 本店不卖 / 已售罄 → 移出 */
    if (!d || Number(d.stock) <= 0) {
      removed++;
      return false;
    }
    if (Number(i.price) !== Number(d.price)) {
      i.price = Number(d.price);
      changed++;
    }
    if (d.name) i.name = d.name;
    const cap = Math.min(99, Number(d.stock) || 99);
    if (i.count > cap) {
      i.count = cap;
      capped++;
    }
    return true;
  });
  persist();
  return { removed, changed, capped };
}

/** 由服务端 /menu 下发后调用：打包费以服务端为准（只在合法正整数时才覆盖默认值） */
function setPackFee(fen) {
  const n = Number(fen);
  if (Number.isFinite(n) && n >= 0 && n <= 100000) {
    get().packFee = Math.trunc(n);
    persist();
  }
}

/* ------------------------------ 查询 ------------------------------ */

/** 某菜品在购物车中的总数量（跨辣度聚合），用于列表页角标 */
function getDishCount(dishId) {
  return get()
    .items.filter((i) => i.dishId === dishId)
    .reduce((sum, i) => sum + i.count, 0);
}

/** 该菜品最近一次选的辣度，用作弹层默认值 */
function getLastSpec(dishId) {
  return get().lastSpec[dishId] || '';
}

/** 批量构造「dishId -> count」映射，点单列表一次 setData 就够 */
function getCountMap() {
  const map = {};
  get().items.forEach((i) => {
    map[i.dishId] = (map[i.dishId] || 0) + i.count;
  });
  return map;
}

/**
 * 金额汇总
 * goods   菜品小计
 * soupFee 锅底费
 * packFee 打包费（仅自取）
 * total   应付
 */
function getSummary() {
  const s = get();
  let goods = 0;
  let count = 0;
  s.items.forEach((i) => {
    goods += i.price * i.count;
    count += i.count;
  });
  const soupFee = s.soup ? s.soup.price : 0;
  const packFee = s.diningType === 'takeout' && count > 0 ? s.packFee : 0;
  const total = goods + soupFee + packFee;
  return {
    count,
    kinds: s.items.length,
    goodsAmount: goods,
    soupFee,
    packFee,
    total,
    totalText: fen2yuan(total),
    goodsText: fen2yuan(goods),
    soupFeeText: fen2yuan(soupFee),
    packFeeText: fen2yuan(packFee),
    /** 是否满足下单条件：有菜品 + 已选锅底 + 堂食需有桌号 */
    canSubmit:
      s.items.length > 0 &&
      !!s.soup &&
      (s.diningType === 'takeout' || !!s.tableNo),
  };
}

/** 生成下单明细快照（提交订单后即使用户再改购物车也不受影响） */
function toOrderItems() {
  const s = get();
  return s.items.map((i) => ({
    key: i.key,
    dishId: i.dishId,
    name: i.name,
    emoji: i.emoji,
    price: i.price,
    unit: i.unit,
    count: i.count,
    spicyId: i.spicyId,
    spicyName: i.spicyName,
    specText: i.spicyName ? i.spicyName : '默认口味',
    amount: i.price * i.count,
  }));
}

module.exports = {
  get,
  subscribe,
  add,
  setCount,
  remove,
  reduceDish,
  clear,
  clearAll,
  setSoup,
  toggleDip,
  setDiningType,
  setTableNo,
  setPeopleCount,
  setRemark,
  setPackFee,
  reprice,
  getDishCount,
  getLastSpec,
  getCountMap,
  getSummary,
  toOrderItems,
  makeKey,
};
