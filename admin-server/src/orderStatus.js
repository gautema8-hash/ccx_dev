/**
 * 订单状态常量（管理系统后端）
 *
 * ⚠️ 同步约定：本文件必须与 `miniprogram-server/src/routes/order.js` 的 `ORDER_STATUS`
 * 保持一致。状态机本身**不在本服务**（只有一份，在小程序后端），
 * 这里只保留「读/展示/筛选」需要的常量，避免为了几个字符串去做一次服务调用。
 *
 * 修改任一侧时，两侧都要改，并由 `docs/02-系统架构文档.md` 的契约章节记录。
 */
const ORDER_STATUS = {
  UNPAID: 'UNPAID',
  PAID: 'PAID',
  ACCEPTED: 'ACCEPTED',
  COOKING: 'COOKING',
  READY: 'READY',
  DONE: 'DONE',
  CANCELED: 'CANCELED',
};

/** 管理端展示用文案 */
const STATUS_TEXT = {
  UNPAID: '待支付',
  PAID: '已支付',
  ACCEPTED: '已接单',
  COOKING: '制作中',
  READY: '待取餐',
  DONE: '已完成',
  CANCELED: '已取消',
};

/** 管理端可推进的动作（与小程序后端 flow.js 的 FLOW 对应） */
const FLOW_ACTIONS = ['accept', 'cook', 'ready', 'done'];

module.exports = { ORDER_STATUS, STATUS_TEXT, FLOW_ACTIONS };
