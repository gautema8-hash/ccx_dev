/**
 * 在线客服（「我的 → 在线客服」）+ 媒体上传（image/voice/video/file）
 *
 * 交互模型：单会话（工单）模式
 *   · 一个用户同时只有一个 OPEN 工单，历史工单关闭后可再次发起（新开一条）
 *   · 客户端用「增量拉取」（since=最后一条消息 id）轮询，避免长连接在小程序端的兼容成本
 *   · 后台客服在管理端回复 → 落到同一条工单，sender=ADMIN
 *
 * 为什么不做 WebSocket：小程序 WebSocket 在切后台/弱网下的重连与心跳成本高，
 * 且本项目客服消息量级很小（单店日均几十条），3-5 秒增量轮询足够，且天然可重试、可断点续传。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const redis = require('../redis');
const config = require('../config');
const logger = require('../logger');
const { bizError, notFound, tooMany, CODES } = require('../errors');

const UPLOAD_ROOT = path.resolve(__dirname, '../../uploads');
const MSG_PAGE = 50;
const SEARCH_MAX = 500;

/* ============================================================ 工单 ============================================================ */

/** 取当前 OPEN 工单，没有就创建（含欢迎语） */
async function ensureTicket(userId, storeId) {
  let ticket = await db.queryOne(
    "SELECT * FROM mp_service_ticket WHERE user_id = ? AND status = 'OPEN' ORDER BY id DESC LIMIT 1",
    [userId]
  );
  if (ticket) return ticket;

  const now = Date.now();
  const r = await db.execute(
    `INSERT INTO mp_service_ticket (user_id, store_id, status, last_msg_at, last_preview, user_unread, admin_unread, created_at, updated_at)
     VALUES (?,?,'OPEN',?,'',0,0,?,?)`,
    [userId, storeId || '', now, now, now]
  );
  ticket = await db.queryOne('SELECT * FROM mp_service_ticket WHERE id = ?', [r.insertId]);
  await insertMessage(ticket.id, 0, 'SYSTEM', 'text', GREETING, '', '');
  return ticket;
}

const GREETING =
  '你好呀，我是串串香客服小助手 🌶️\n' +
  '· 订单 / 取餐问题：直接告诉我取餐号\n' +
  '· 发票问题：可点下方「发票管理」自助申请\n' +
  '· 人工客服在线时间：每天 10:00 - 22:00';

const QUICK_REPLIES = [
  { key: 'order', label: '查询订单进度', send: '帮我查一下我的订单进度，取餐号：' },
  { key: 'invoice', label: '发票怎么开', send: '我想开发票，请问怎么操作？' },
  { key: 'refund', label: '退款问题', send: '我的订单需要退款，原因是：' },
  { key: 'voucher', label: '团购券核销', send: '我的团购券核销失败了，券码是：' },
  { key: 'human', label: '转人工客服', send: '请帮我转人工客服' },
];

function messageDto(m) {
  let meta = {};
  try {
    meta = m.media_meta ? JSON.parse(m.media_meta) : {};
  } catch (e) {
    meta = {};
  }
  return {
    id: Number(m.id),
    sender: m.sender, // USER | ADMIN | SYSTEM
    type: m.msg_type,
    content: m.content || '',
    mediaUrl: m.media_url || '',
    meta,
    createdAt: Number(m.created_at),
  };
}

async function insertMessage(ticketId, userId, sender, type, content, mediaUrl, mediaMeta) {
  const now = Date.now();
  const r = await db.execute(
    `INSERT INTO mp_service_message (ticket_id, user_id, sender, msg_type, content, media_url, media_meta, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [ticketId, userId, sender, type, content || '', mediaUrl || '', mediaMeta || '', now]
  );
  const preview =
    type === 'text'
      ? String(content || '').replace(/\s+/g, ' ').slice(0, 40)
      : { image: '[图片]', video: '[视频]', voice: '[语音]', file: '[文件]' }[type] || '[' + type + ']';
  return { id: r.insertId, preview, now };
}

/** 会话首页：工单 + 最近消息 + 快捷问题 */
async function session(ctx) {
  const ticket = await ensureTicket(ctx.user.id, String(ctx.query.storeId || '').slice(0, 32));
  const rows = await db.query(
    'SELECT * FROM mp_service_message WHERE ticket_id = ? ORDER BY id DESC LIMIT ?',
    [ticket.id, MSG_PAGE]
  );
  rows.reverse();
  /* 进入会话即视为已读：清零用户未读，管理端未读不变 */
  if (ticket.user_unread) {
    await db.execute('UPDATE mp_service_ticket SET user_unread = 0 WHERE id = ?', [ticket.id]);
  }
  return ctx.ok({
    ticket: { id: ticket.id, status: ticket.status, storeId: ticket.store_id, createdAt: Number(ticket.created_at) },
    messages: rows.map(messageDto),
    quickReplies: QUICK_REPLIES,
    greeting: GREETING,
    serverTime: Date.now(),
  });
}

/** 增量拉取（轮询）：返回 id > since 的消息 */
async function messages(ctx) {
  const ticket = await ensureTicket(ctx.user.id, '');
  const since = Number(ctx.query.since || 0);
  const rows = await db.query(
    'SELECT * FROM mp_service_message WHERE ticket_id = ? AND id > ? ORDER BY id ASC LIMIT 200',
    [ticket.id, since]
  );
  if (rows.length) {
    await db.execute('UPDATE mp_service_ticket SET user_unread = 0 WHERE id = ?', [ticket.id]);
  }
  const list = rows.map(messageDto);
  return ctx.ok({ list, maxId: list.length ? list[list.length - 1].id : since, serverTime: Date.now() });
}

const MSG_TYPES = ['text', 'image', 'video', 'voice', 'file'];
const META_MAX = 480;

/** 发送消息（文本 / 媒体） */
async function send(ctx) {
  const rl = await redis.rateLimit.hit('svcmsg:' + ctx.user.id, 60, 60);
  if (!rl.allowed) throw tooMany('发送过于频繁，请稍后再试');

  const b = ctx.body || {};
  const type = MSG_TYPES.indexOf(String(b.type || 'text')) > -1 ? String(b.type || 'text') : 'text';
  const ticket = await ensureTicket(ctx.user.id, String(b.storeId || '').slice(0, 32));

  let content = '';
  let mediaUrl = '';
  let mediaMeta = '';

  if (type === 'text') {
    content = String(b.content == null ? '' : b.content).trim().slice(0, SEARCH_MAX);
    if (!content) throw bizError(CODES.PARAM_INVALID, '消息内容不能为空');
  } else {
    mediaUrl = String(b.mediaUrl || '');
    /* 只接受本站上传目录或 https，杜绝把外部/伪协议地址塞进聊天记录 */
    if (!/^(\/uploads\/[\w./-]+|https:\/\/[\w./?=&%-]+)$/.test(mediaUrl)) {
      throw bizError(CODES.PARAM_INVALID, '媒体地址不合法，请重新上传');
    }
    const meta = b.meta && typeof b.meta === 'object' ? b.meta : {};
    const slim = {
      duration: Math.max(0, Math.min(600, Number(meta.duration) || 0)),
      size: Math.max(0, Number(meta.size) || 0),
      name: String(meta.name || '').slice(0, 80),
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
    };
    mediaMeta = JSON.stringify(slim).slice(0, META_MAX);
    content = String(b.content || '').slice(0, 100); // 媒体消息可带一句说明
  }

  const ins = await insertMessage(ticket.id, ctx.user.id, 'USER', type, content, mediaUrl, mediaMeta);
  await db.execute(
    `UPDATE mp_service_ticket
     SET last_msg_at = ?, last_preview = ?, admin_unread = admin_unread + 1, updated_at = ?
     WHERE id = ?`,
    [ins.now, ins.preview, ins.now, ticket.id]
  );

  /* 自动应答：1 小时内只回一次，避免刷屏；人工客服上线前的兜底 */
  let autoReply = null;
  const ackKey = 'svc:ack:' + ticket.id;
  const acked = await redis.cache.get(ackKey);
  if (!acked) {
    await redis.cache.set(ackKey, '1', 3600);
    const text = '收到！客服会尽快回复你（人工在线 10:00-22:00）。紧急问题可直接致电 400-888-6666。';
    const ack = await insertMessage(ticket.id, 0, 'SYSTEM', 'text', text, '', '');
    autoReply = messageDto({
      id: ack.id,
      sender: 'SYSTEM',
      msg_type: 'text',
      content: text,
      media_url: '',
      media_meta: '',
      created_at: ack.now,
    });
  }

  return ctx.ok({ message: messageDto({
    id: ins.id,
    sender: 'USER',
    msg_type: type,
    content,
    media_url: mediaUrl,
    media_meta: mediaMeta,
    created_at: ins.now,
  }), autoReply, ticketId: ticket.id });
}

/** 结束会话（用户主动）：下次进入会新建工单 */
async function close(ctx) {
  const ticket = await db.queryOne(
    "SELECT * FROM mp_service_ticket WHERE user_id = ? AND status = 'OPEN' ORDER BY id DESC LIMIT 1",
    [ctx.user.id]
  );
  if (!ticket) return ctx.ok({ ok: true, closed: false });
  const now = Date.now();
  await db.execute("UPDATE mp_service_ticket SET status = 'CLOSED', updated_at = ? WHERE id = ?", [now, ticket.id]);
  await insertMessage(ticket.id, 0, 'SYSTEM', 'text', '本次会话已结束，如需继续咨询可重新发起。', '', '');
  return ctx.ok({ ok: true, closed: true });
}

/* ============================================================ 媒体上传 ============================================================ */

/** 按用途限制扩展名与大小（同时校验魔数，防止改扩展名上传可执行内容） */
const KIND_RULE = {
  image: { exts: ['jpg', 'jpeg', 'png', 'gif', 'webp'], dir: 'chat' },
  voice: { exts: ['mp3', 'm4a', 'aac', 'wav', 'amr'], dir: 'voice' },
  video: { exts: ['mp4', 'mov', 'm4v'], dir: 'video' },
  file: { exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv', 'zip'], dir: 'file' },
};

function sniff(buf, ext) {
  const b = buf;
  if (ext === 'jpg' || ext === 'jpeg') return b[0] === 0xff && b[1] === 0xd8;
  if (ext === 'png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (ext === 'gif') return b.slice(0, 4).toString('latin1') === 'GIF8';
  if (ext === 'webp') return b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP';
  if (ext === 'mp4' || ext === 'mov' || ext === 'm4v') return b.slice(4, 8).toString('latin1') === 'ftyp';
  /* 语音/文档格式较杂（AAC 无统一头、doc/xls 为 OLE 复合文档），只做「非空 + 扩展名白名单」 */
  return b.length > 0;
}

/**
 * 媒体上传（multipart/form-data）
 * 入参：kind=image|voice|video|file，file=二进制
 * 说明：不用 base64 —— 视频/语音 base64 后体积 +33%，且客户端要整块拼字符串，
 *       低端机上传 10MB 视频时会直接 OOM。multipart 由 wx.uploadFile 流式发送更稳。
 */
async function upload(ctx) {
  const rl = await redis.rateLimit.hit('upload:' + ctx.user.id, 60, 60);
  if (!rl.allowed) throw tooMany('上传过于频繁，请稍后再试');

  const kind = String(ctx.body.kind || 'image');
  const rule = KIND_RULE[kind] || KIND_RULE.file;
  const file = (ctx.files || [])[0];
  if (!file || !file.buffer || !file.buffer.length) throw bizError(CODES.PARAM_INVALID, '未收到文件');

  const rawExt = String(file.filename || '').match(/\.(\w+)$/);
  let ext = (rawExt ? rawExt[1] : '').toLowerCase();
  if (rule.exts.indexOf(ext) === -1) {
    /* 部分安卓机不带扩展名：按 content-type 兜底映射 */
    const ct = file.contentType || '';
    ext = ct.indexOf('png') > -1 ? 'png'
      : ct.indexOf('gif') > -1 ? 'gif'
      : ct.indexOf('webp') > -1 ? 'webp'
      : ct.indexOf('jpeg') > -1 || ct.indexOf('jpg') > -1 ? 'jpg'
      : ct.indexOf('mp4') > -1 ? 'mp4'
      : ct.indexOf('mpeg') > -1 ? 'mp3'
      : ct.indexOf('pdf') > -1 ? 'pdf'
      : '';
  }
  if (rule.exts.indexOf(ext) === -1) {
    throw bizError(CODES.PARAM_INVALID, '不支持的文件类型（' + KIND_RULE[kind].exts.join('/') + '）');
  }

  const maxSize = config.upload.maxSize[kind] || config.upload.maxSize.file;
  if (file.buffer.length > maxSize) {
    throw bizError(CODES.PARAM_INVALID, `文件过大，${kind === 'video' ? '视频' : '文件'}请控制在 ${Math.round(maxSize / 1024 / 1024)}MB 内`);
  }
  if (!sniff(file.buffer, ext)) throw bizError(CODES.PARAM_INVALID, '文件内容与格式不符，请重新选择');

  const dir = path.join(UPLOAD_ROOT, rule.dir);
  fs.mkdirSync(dir, { recursive: true });
  const name = 'u' + ctx.user.id + '_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(dir, name), file.buffer);

  const url = '/uploads/' + rule.dir + '/' + name;
  logger.info('media uploaded', { uid: ctx.user.id, kind, size: file.buffer.length, ext });
  return ctx.ok({
    url,
    kind,
    ext,
    size: file.buffer.length,
    name: String(file.filename || '').slice(0, 80),
  });
}

module.exports = { session, messages, send, close, upload, ensureTicket, insertMessage, QUICK_REPLIES };
