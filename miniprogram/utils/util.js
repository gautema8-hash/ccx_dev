/** 通用工具函数 */

/** 分 → 元字符串，保留两位小数。300 => '3.00' */
function fen2yuan(fen) {
  const n = Number(fen) || 0;
  return (n / 100).toFixed(2);
}

/** 元 → 分，避免浮点误差 */
function yuan2fen(yuan) {
  return Math.round((Number(yuan) || 0) * 100);
}

/** 金额格式化：超 1 万走「万」 */
function formatAmount(fen) {
  const y = fen2yuan(fen);
  return y;
}

/** 补零 */
function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

/** 时间戳 → 'MM-dd HH:mm' / 'HH:mm' */
function formatTime(ts, withDate) {
  const d = new Date(ts);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}` : t;
}

/** 时间戳 → 'YYYY-MM-dd HH:mm:ss' */
function formatFull(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 相对时间：刚刚 / 3 分钟前 */
function fromNow(ts) {
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 24 * 3600 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
  return formatTime(ts, true);
}

/** 订单号：LBZ + yyyyMMddHHmmss + 3 位随机 */
function genOrderNo() {
  const d = new Date();
  const rand = Math.floor(Math.random() * 900 + 100);
  return (
    'LBZ' +
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds()) +
    rand
  );
}

/** 本地唯一 ID */
function uid(prefix) {
  return (
    (prefix || 'id') +
    '_' +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 7)
  );
}

/** 取餐号：A01 ~ A99 循环 */
function genPickupNo() {
  const n = (Number(wx.getStorageSync('lbz_pickup_seq')) || 0) + 1;
  wx.setStorageSync('lbz_pickup_seq', n % 99);
  return 'A' + pad(n % 99 === 0 ? 99 : n);
}

/** 节流（用于 scroll 高频事件） */
function throttle(fn, wait) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last < wait) return;
    last = now;
    return fn.apply(this, args);
  };
}

/** 统一错误提示 */
function toast(title, icon) {
  wx.showToast({ title: title || '操作失败', icon: icon || 'none', duration: 1800 });
}

/** 确认弹窗（Promise 化） */
function confirm(content, title) {
  return new Promise((resolve) => {
    wx.showModal({
      title: title || '提示',
      content,
      confirmColor: '#C62828',
      success: (res) => resolve(!!res.confirm),
      fail: () => resolve(false),
    });
  });
}

module.exports = {
  fen2yuan,
  yuan2fen,
  formatAmount,
  formatTime,
  formatFull,
  fromNow,
  genOrderNo,
  genPickupNo,
  uid,
  throttle,
  toast,
  confirm,
  pad,
};
