/**
 * 在线客服服务：会话 / 消息 / 媒体上传
 *
 * 轮询策略：页面可见时每 4 秒拉一次增量（since=最后一条消息 id），
 * 切后台立即停止 —— 小程序切后台后定时器仍会跑，不停会白耗流量与电量。
 */
const config = require('../utils/config');
const { request, getToken } = require('../utils/request');

const POLL_INTERVAL = 4000;

/** 会话首页：工单 + 最近消息 + 快捷问题 */
function session(storeId) {
  if (config.USE_MOCK) {
    return Promise.resolve({
      ticket: { id: 0, status: 'OPEN' },
      messages: [
        {
          id: 1,
          sender: 'SYSTEM',
          type: 'text',
          content: '你好呀，我是串串香客服小助手 🌶️（当前为离线演示，消息不会发送到真实客服）',
          mediaUrl: '',
          meta: {},
          createdAt: Date.now(),
        },
      ],
      quickReplies: [
        { key: 'order', label: '查询订单进度', send: '帮我查一下我的订单进度，取餐号：' },
        { key: 'invoice', label: '发票怎么开', send: '我想开发票，请问怎么操作？' },
        { key: 'human', label: '转人工客服', send: '请帮我转人工客服' },
      ],
      greeting: '',
      serverTime: Date.now(),
    });
  }
  return request({ url: '/service/session', method: 'GET', data: { storeId: storeId || '' }, idempotent: true });
}

/** 增量拉取（轮询） */
function pull(since) {
  if (config.USE_MOCK) return Promise.resolve({ list: [], maxId: since || 0 });
  return request({ url: '/service/messages', method: 'GET', data: { since: since || 0 }, idempotent: true });
}

/**
 * 发消息
 * 不标记 idempotent：网络层重试会让「已发送但响应丢失」的消息重复发一次，
 * 用户端看到两条一模一样的消息比「失败后手动重发」更糟。
 */
function send(payload) {
  if (config.USE_MOCK) {
    const msg = Object.assign(
      { id: Date.now(), sender: 'USER', createdAt: Date.now(), content: '', mediaUrl: '', meta: {} },
      payload
    );
    const autoReply = {
      id: msg.id + 1,
      sender: 'SYSTEM',
      type: 'text',
      content: '收到！（离线演示模式，未接入真实客服）',
      mediaUrl: '',
      meta: {},
      createdAt: Date.now(),
    };
    return Promise.resolve({ message: msg, autoReply, ticketId: 0 });
  }
  return request({ url: '/service/messages', method: 'POST', data: payload });
}

/** 结束会话 */
function close() {
  if (config.USE_MOCK) return Promise.resolve({ ok: true });
  return request({ url: '/service/close', method: 'POST', idempotent: true });
}

const KIND_RULE = {
  image: { ext: 'jpg', max: 5 * 1024 * 1024, label: '图片' },
  voice: { ext: 'mp3', max: 2 * 1024 * 1024, label: '语音' },
  video: { ext: 'mp4', max: 15 * 1024 * 1024, label: '视频' },
  file: { ext: 'txt', max: 10 * 1024 * 1024, label: '文件' },
};

/**
 * 媒体上传：multipart 直传（不用 base64 —— 视频 base64 后体积 +33%，低端机还会 OOM）
 * @param {string} filePath 本地临时路径
 * @param {string} kind image|voice|video|file
 * @param {object} extra 额外表单字段（如 duration）
 */
function upload(filePath, kind, extra) {
  if (config.USE_MOCK) {
    return Promise.resolve({ url: '', kind: kind, ext: '', size: 0, name: 'mock' });
  }
  const rule = KIND_RULE[kind] || KIND_RULE.file;
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: config.BASE_URL + '/upload',
      filePath: filePath,
      name: 'file',
      formData: Object.assign({ kind: kind }, extra || {}),
      timeout: 60000,
      header: { Authorization: 'Bearer ' + getToken(), 'X-Client-Version': config.VERSION },
      success(res) {
        let body = {};
        try {
          body = JSON.parse(res.data || '{}');
        } catch (e) {
          return reject({ code: -1, message: '上传响应解析失败' });
        }
        if (body.code !== 0) return reject(Object.assign({ code: body.code }, { message: body.message || '上传失败' }));
        resolve(body.data);
      },
      fail(err) {
        const msg = String((err && err.errMsg) || '');
        reject({
          code: -1,
          message: msg.indexOf('exceed') > -1 ? rule.label + '过大' : '上传失败，请检查网络后重试',
        });
      },
    });
  });
}

module.exports = { session, pull, send, close, upload, POLL_INTERVAL, KIND_RULE };
