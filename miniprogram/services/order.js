/**
 * 订单服务层 + 订单状态机
 *
 * 状态流转：UNPAID → PAID → ACCEPTED → COOKING → READY → DONE，可分支 CANCELED
 *
 * 双模运行：
 *   USE_MOCK = false（默认，对接后端）：所有请求走 /miniapp/v1，视图模型统一由 decorate() 产出
 *   USE_MOCK = true （离线演示/预览版）：走本地 Storage，状态按支付后秒数推导
 *
 * 交付级要点：
 *   · 下单带 Idempotency-Key，网络重试不会产生第二笔订单
 *   · 支付走服务端 prepay；服务端 PAY_MODE=mock 时自动降级为本地收银台并回调 /mock-pay，
 *     两种模式下「结算」都是服务端那一份代码
 *   · 所有金额以服务端为准，客户端传的 amount 仅用于展示预览
 */
const config = require('../utils/config');
const { request } = require('../utils/request');
const { genOrderNo, genPickupNo, uid, fen2yuan } = require('../utils/util');

const ORDER_KEY = 'lbz_orders_v1';

const STATUS = {
  UNPAID: 'UNPAID',
  PAID: 'PAID',
  ACCEPTED: 'ACCEPTED',
  COOKING: 'COOKING',
  READY: 'READY',
  DONE: 'DONE',
  CANCELED: 'CANCELED',
};

const STATUS_META = {
  UNPAID: { text: '待付款', desc: '请在 15 分钟内完成支付，超时自动取消', step: 0, color: '#C62828' },
  PAID: { text: '待接单', desc: '支付成功，等待商家接单', step: 1, color: '#FF8F1F' },
  ACCEPTED: { text: '商家已接单', desc: '后厨正在备菜，马上开涮', step: 2, color: '#FF8F1F' },
  COOKING: { text: '涮煮中', desc: '锅底已上桌，串串正在翻滚', step: 3, color: '#C62828' },
  READY: { text: '已上桌 / 可取餐', desc: '请核对菜品，尽情享用', step: 4, color: '#1B8A3E' },
  DONE: { text: '已完成', desc: '感谢光临老北京麻辣串串香', step: 5, color: '#8A8A8E' },
  CANCELED: { text: '已取消', desc: '订单已取消，如有疑问请联系门店', step: -1, color: '#8A8A8E' },
};

const TIMELINE_STEPS = [
  { key: STATUS.PAID, text: '支付成功' },
  { key: STATUS.ACCEPTED, text: '商家接单' },
  { key: STATUS.COOKING, text: '开始涮煮' },
  { key: STATUS.READY, text: '已上桌 / 可取餐' },
  { key: STATUS.DONE, text: '订单完成' },
];

/** Mock 模式的状态推进时间表（秒） */
const MOCK_SCHEDULE = [
  { at: 0, status: STATUS.PAID },
  { at: 12, status: STATUS.ACCEPTED },
  { at: 40, status: STATUS.COOKING },
  { at: 95, status: STATUS.READY },
];

const FILTERS = [
  { key: 'all', name: '全部' },
  { key: 'ongoing', name: '进行中' },
  { key: 'done', name: '已完成' },
];

/* ============================ Mock 本地存储 ============================ */
function readAll() {
  return wx.getStorageSync(ORDER_KEY) || [];
}
function writeAll(list) {
  wx.setStorageSync(ORDER_KEY, list);
}

function isOngoing(status) {
  return status !== STATUS.DONE && status !== STATUS.CANCELED;
}

function fmt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : n);
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function buildStatusText(status, diningType) {
  if (status === STATUS.READY) return diningType === 'takeout' ? '可取餐' : '已上桌';
  return STATUS_META[status] ? STATUS_META[status].text : '';
}

function buildMockTimeline(order) {
  const step = STATUS_META[order.status] ? STATUS_META[order.status].step : -1;
  const curIdx = step - 1;
  const base = order.payTime || order.createTime;
  const offsets = [0, 12, 40, 95, 140];
  return TIMELINE_STEPS.map((s, i) => ({
    key: s.key,
    text: s.key === STATUS.READY ? buildStatusText(STATUS.READY, order.diningType) : s.text,
    time: i <= curIdx ? base + offsets[i] * 1000 : 0,
    timeText: i <= curIdx ? fmt(base + offsets[i] * 1000) : '',
    done: i <= curIdx,
    current: i === curIdx,
  }));
}

/** 用 mock 时间表推导当前状态 */
function advanceMock(order) {
  if (!order.isMock || !order.payTime || order.status === STATUS.CANCELED) return false;
  if (order.status === STATUS.DONE) return false;
  const elapsed = (Date.now() - order.payTime) / 1000;
  let next = order.status;
  MOCK_SCHEDULE.forEach((s) => {
    if (elapsed >= s.at) next = s.status;
  });
  if (next === order.status) return false;
  order.status = next;
  order.statusText = buildStatusText(next, order.diningType);
  order.timeline = buildMockTimeline(order);
  return true;
}

/* ============================ 视图模型 ============================ */
/**
 * 订单 → 页面视图模型
 * 服务端返回的是领域模型（与本地模型同形），展示字段统一在这里补，
 * 两种模式下页面拿到的结构完全一致。
 */
function decorate(order) {
  if (!order) return null;
  const meta = STATUS_META[order.status] || STATUS_META.UNPAID;
  const items = (order.items || []).map((i) =>
    Object.assign({}, i, {
      priceText: fen2yuan(i.price),
      amountText: fen2yuan(i.amount),
    })
  );
  const itemCount = items.reduce((sum, i) => sum + i.count, 0);
  const summaryText = items.map((i) => i.name + '×' + i.count).join('、');
  const amount = order.amount || {};
  const createTime = Number(order.createTime) || 0;

  return Object.assign({}, order, {
    items,
    itemCount,
    summaryText,
    /** 列表卡片只展示前 4 个缩略图，在服务层切好，WXML 里就不用 wx:for + wx:if 混用 */
    thumbItems: items.slice(0, 4),
    statusText: order.statusText || meta.text,
    statusDesc: meta.desc,
    statusColor: meta.color,
    canCancel: order.status === STATUS.UNPAID,
    canPay: order.status === STATUS.UNPAID,
    canReorder: order.status === STATUS.DONE || order.status === STATUS.CANCELED,
    canFinish:
      order.status === STATUS.READY || order.status === STATUS.COOKING || order.status === STATUS.ACCEPTED,
    /** 新增：催单 / 退款 / 评价 / 加菜 */
    canUrge: [STATUS.PAID, STATUS.ACCEPTED, STATUS.COOKING].indexOf(order.status) > -1,
    canRefund: order.status === STATUS.PAID || order.status === STATUS.ACCEPTED,
    canRate: order.status === STATUS.DONE && !order.rated,
    canAddDish:
      order.status === STATUS.PAID ||
      order.status === STATUS.ACCEPTED ||
      order.status === STATUS.COOKING ||
      order.status === STATUS.READY,
    createTimeText: fmt(createTime),
    createDateText: createTime
      ? new Date(createTime).getMonth() + 1 + '月' + new Date(createTime).getDate() + '日 ' + fmt(createTime)
      : '',
    amount: {
      goods: amount.goods || 0,
      soupFee: amount.soupFee || 0,
      packFee: amount.packFee || 0,
      discount: amount.discount || 0,
      pay: amount.pay || 0,
      payText: fen2yuan(amount.pay),
      goodsText: fen2yuan(amount.goods),
      soupFeeText: fen2yuan(amount.soupFee),
      packFeeText: fen2yuan(amount.packFee),
      discountText: fen2yuan(amount.discount),
    },
    soupText: order.soup ? order.soup.name + '（¥' + fen2yuan(order.soup.price) + '）' : '未选择',
    dipsText: (order.dips || []).length ? order.dips.map((d) => d.name).join('、') : '未选择',
    diningTypeText: order.diningType === 'takeout' ? '到店自取' : '堂食',
    timeline: order.timeline || [],
  });
}

const decorateList = (list) => (Array.isArray(list) ? list.map(decorate) : []);

/* ============================ 对外 API ============================ */

/**
 * 创建订单
 * @param {object} payload { items, soup, dips, diningType, tableNo, peopleCount, remark, coupon, parentOrderId }
 */
function createOrder(payload) {
  if (!config.USE_MOCK) {
    /* 幂等键：同一次下单的用户操作在重试时复用同一个 key，服务端据此回放而非新建 */
    const idemKey =
      'idem_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    return request({
      url: '/orders',
      method: 'POST',
      idempotent: true,
      header: { 'Idempotency-Key': idemKey },
      data: payload,
    }).then(decorate);
  }

  const now = Date.now();
  const order = {
    id: uid('O'),
    orderNo: genOrderNo(),
    pickupNo: genPickupNo(),
    shopId: 'shop_001',
    shopName: '老北京麻辣串串香·簋街总店',
    status: STATUS.UNPAID,
    statusText: STATUS_META.UNPAID.text,
    diningType: payload.diningType,
    tableNo: payload.tableNo || '',
    peopleCount: payload.peopleCount || 1,
    items: payload.items,
    soup: payload.soup,
    dips: payload.dips || [],
    remark: payload.remark || '',
    coupon: payload.coupon || null,
    amount: payload.amount,
    createTime: now,
    payTime: 0,
    updateTime: now,
    timeline: buildMockTimeline({ status: STATUS.UNPAID, createTime: now }),
    isMock: true,
  };
  const list = readAll();
  list.unshift(order);
  writeAll(list);
  return Promise.resolve(decorate(order));
}

/**
 * 支付
 * 真实模式：prepay → (服务端 mock 则本地收银台 + /mock-pay) | (真实则 wx.requestPayment)
 */
function payOrder(orderId) {
  if (config.USE_MOCK) return mockPay(orderId);

  return request({ url: '/orders/' + orderId + '/prepay', method: 'POST', idempotent: true })
    .then((pre) => {
      if (pre && pre.alreadyPaid) return null;
      if (pre && pre.mock) return mockCashier(orderId, pre);
      return wxPay(pre);
    })
    .then(() => getOrder(orderId));
}

/** 真实微信支付 */
function wxPay(params) {
  return new Promise((resolve, reject) => {
    wx.requestPayment({
      timeStamp: params.timeStamp,
      nonceStr: params.nonceStr,
      package: params.package,
      signType: params.signType || 'RSA',
      paySign: params.paySign,
      success: () => resolve(),
      fail: (err) => {
        const msg = String((err && err.errMsg) || '');
        if (msg.indexOf('cancel') > -1) reject({ code: 'CANCEL', message: '已取消支付' });
        else reject({ code: 'PAY_FAIL', message: '支付失败，请重试', detail: err });
      },
    });
  });
}

/** 服务端处于 mock 支付模式时的本地收银台 */
function mockCashier(orderId, pre) {
  return new Promise((resolve) => {
    wx.showModal({
      title: '模拟支付',
      content: '应付 ¥' + (pre.amountText || (pre.amount / 100).toFixed(2)) + '\n（服务端 PAY_MODE=mock，未接入商户号）',
      confirmText: '确认支付',
      cancelText: '取消',
      confirmColor: '#C62828',
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false),
    });
  }).then((ok) => {
    if (!ok) throw { code: 'CANCEL', message: '已取消支付' };
    return request({ url: '/orders/' + orderId + '/mock-pay', method: 'POST', idempotent: true });
  });
}

/** Mock 模式下本地模拟支付 */
function mockPay(orderId) {
  const list = readAll();
  const idx = list.findIndex((o) => o.id === orderId);
  if (idx === -1) return Promise.reject({ message: '订单不存在' });
  const cur = list[idx].status;
  if (cur === STATUS.CANCELED) return Promise.reject({ code: 'ORDER_CANCELED', message: '订单已取消，无法支付' });
  if (cur !== STATUS.UNPAID) return Promise.resolve(decorate(list[idx]));

  list[idx].status = STATUS.PAID;
  list[idx].payTime = Date.now();
  list[idx].updateTime = Date.now();
  list[idx].statusText = STATUS_META.PAID.text;
  list[idx].timeline = buildMockTimeline(list[idx]);
  writeAll(list);
  requestSubscribeMessage(list[idx]);
  return Promise.resolve(decorate(list[idx]));
}

function cancelOrder(orderId, reason) {
  if (!config.USE_MOCK) {
    return request({ url: '/orders/' + orderId + '/cancel', method: 'POST', data: { reason } }).then(decorate);
  }
  const list = readAll();
  const idx = list.findIndex((o) => o.id === orderId);
  if (idx === -1) return Promise.reject({ message: '订单不存在' });
  list[idx].status = STATUS.CANCELED;
  list[idx].statusText = STATUS_META.CANCELED.text;
  list[idx].cancelReason = reason || '用户主动取消';
  list[idx].updateTime = Date.now();
  list[idx].timeline = buildMockTimeline(list[idx]);
  writeAll(list);
  return Promise.resolve(decorate(list[idx]));
}

function finishOrder(orderId) {
  if (!config.USE_MOCK) {
    return request({ url: '/orders/' + orderId + '/finish', method: 'POST', idempotent: true }).then(decorate);
  }
  const list = readAll();
  const idx = list.findIndex((o) => o.id === orderId);
  if (idx === -1) return Promise.reject({ message: '订单不存在' });
  list[idx].status = STATUS.DONE;
  list[idx].statusText = STATUS_META.DONE.text;
  list[idx].finishTime = Date.now();
  list[idx].updateTime = Date.now();
  list[idx].timeline = buildMockTimeline(list[idx]);
  writeAll(list);
  return Promise.resolve(decorate(list[idx]));
}

/** 催单 */
function urgeOrder(orderId) {
  if (!config.USE_MOCK) {
    return request({ url: '/orders/' + orderId + '/urge', method: 'POST' });
  }
  return Promise.resolve({ ok: true, urgeCount: 1 });
}

/** 申请退款 */
function applyRefund(orderId, reason) {
  if (!config.USE_MOCK) {
    return request({ url: '/orders/' + orderId + '/refund', method: 'POST', data: { reason } });
  }
  return Promise.resolve({ ok: true });
}

/** 评价 */
function submitFeedback(orderId, score, content) {
  if (!config.USE_MOCK) {
    return request({ url: '/orders/' + orderId + '/feedback', method: 'POST', data: { score, content } });
  }
  const list = readAll();
  const idx = list.findIndex((o) => o.id === orderId);
  if (idx > -1) {
    list[idx].rated = true;
    writeAll(list);
  }
  return Promise.resolve({ ok: true });
}

/** 主动查单补偿（支付结果不明时用） */
function queryPay(orderId) {
  if (!config.USE_MOCK) {
    return request({ url: '/orders/' + orderId + '/query-pay', method: 'POST', idempotent: true });
  }
  return Promise.resolve({ paid: false, mock: true });
}

/** 订单列表：filter = all | ongoing | done */
function listOrders(filter, page) {
  if (!config.USE_MOCK) {
    return request({
      url: '/orders',
      data: { filter: filter || 'all', page: page || 1, size: 10 },
    }).then(decorateList);
  }
  let list = readAll();
  let changed = false;
  list.forEach((o) => {
    if (advanceMock(o)) changed = true;
  });
  if (changed) writeAll(list);
  if (filter === 'ongoing') list = list.filter((o) => isOngoing(o.status));
  if (filter === 'done') list = list.filter((o) => !isOngoing(o.status));
  return Promise.resolve(decorateList(list));
}

function getOrder(id) {
  if (!config.USE_MOCK) {
    return request({ url: '/orders/' + id, method: 'GET' }).then(decorate);
  }
  const found = readAll().find((o) => o.id === id);
  if (!found) return Promise.reject({ message: '订单不存在' });
  return Promise.resolve(decorate(found));
}

/** Mock 模式下详情页轮询用：推进状态并返回最新订单 */
function refreshStatus(orderId) {
  if (!config.USE_MOCK) return null;
  const list = readAll();
  const idx = list.findIndex((o) => o.id === orderId);
  if (idx === -1) return null;
  if (advanceMock(list[idx])) {
    list[idx].updateTime = Date.now();
    writeAll(list);
  }
  return decorate(list[idx]);
}

/** 把历史订单的明细回填到购物车（再来一单） */
function reorder(orderId) {
  const cart = require('../utils/cart');
  return getOrder(orderId).then((order) => {
    (order.items || []).forEach((i) => {
      cart.add(
        { id: i.dishId, name: i.name, emoji: i.emoji, price: i.price, unit: i.unit, desc: '' },
        { spicyId: i.spicyId, spicyName: i.spicyName },
        i.count
      );
    });
    if (order.soup) cart.setSoup(order.soup);
    cart.setDiningType(order.diningType);
    if (order.tableNo) cart.setTableNo(order.tableNo);
    return order;
  });
}

/**
 * 订阅消息：下单后是用户授权意愿最高的时刻
 * 一次最多 3 个模板；用户勾选「总是保持以上选择」后不再弹窗
 */
function requestSubscribeMessage(order) {
  const tmplIds = [config.TMPL.ORDER_PAID, config.TMPL.ORDER_READY].filter(
    (id) => id && id.indexOf('REPLACE_WITH') === -1
  );
  if (!tmplIds.length || !wx.requestSubscribeMessage) return;
  wx.requestSubscribeMessage({
    tmplIds,
    success: (res) => {
      const accepted = tmplIds.filter((id) => res[id] === 'accept');
      console.log('[subscribe] accepted:', accepted.join(','), 'order:', order.orderNo);
    },
    fail: (e) => console.warn('[subscribe] fail', e),
  });
}

module.exports = {
  STATUS,
  STATUS_META,
  TIMELINE_STEPS,
  FILTERS,
  createOrder,
  payOrder,
  cancelOrder,
  finishOrder,
  urgeOrder,
  applyRefund,
  submitFeedback,
  queryPay,
  listOrders,
  getOrder,
  reorder,
  refreshStatus,
  isOngoing,
  decorate,
  requestSubscribeMessage,
};
