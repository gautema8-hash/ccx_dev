/**
 * 内部服务接口（仅管理系统后端可调用）
 *
 * ── 为什么单独开一组 /internal ──
 * 订单状态机、券抵扣、团购券防重核销、库存扣减回滚这些领域规则**只有本服务一份实现**。
 * 管理端需要推进订单、审核退款、核销券、改库存，但不能复制这些规则
 * （复制 = 状态机分裂 = 迟早出状态错乱或超卖），所以由本服务以内部接口暴露。
 *
 * ── 鉴权 ──
 *   · 请求头 X-Internal-Token 必须等于配置的 INTERNAL_TOKEN
 *   · 未配置 INTERNAL_TOKEN 时**拒绝所有调用**（避免默认空串导致"谁都能调"）
 *   · 建议仅监听内网 / 由网关限制来源 IP
 *
 * ── 与公开接口的区别 ──
 *   不做用户鉴权（无 ctx.user），操作者身份由 body.staffId 传入并写审计/状态日志。
 */
const db = require('../db');
const logger = require('../logger');
const orderRoute = require('./order');
const menuRoute = require('./menu');
const couponService = require('../couponService');
const voucherService = require('../voucherService');
const { bizError, notFound, CODES } = require('../errors');

/** 合法的状态推进动作 */
const ACTIONS = { accept: 'accept', cook: 'cook', ready: 'ready', done: 'done' };

/* ============================================================ 订单查询 */
/**
 * 管理端的订单列表/详情也走这里，而不是让管理端自己拼 SQL 再复制一份 DTO ——
 * 展示口径（字段命名、金额单位、时间格式）必须与小程序端一致，
 * 否则会出现"小程序显示 ¥20、后台显示 2000"这类单位分歧。
 * 门店范围由管理端算好传进来（storeIds），本接口不再重复鉴权。
 */
async function listOrders(ctx) {
  const q = ctx.query || {};
  const params = [];
  let where = 'WHERE 1=1';
  const storeIds = String(q.storeIds || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (storeIds.length) {
    where += ` AND o.store_id IN (${storeIds.map(() => '?').join(',')})`;
    params.push.apply(params, storeIds);
  } else if (q.allStores !== '1') {
    /* 没传门店且未声明全店 → 返回空，兜底方向是「查不到」 */
    return ctx.ok({ list: [], total: 0, page: 1, size: 0 });
  }
  if (q.brandId) {
    where += ' AND o.brand_id = ?';
    params.push(String(q.brandId));
  }
  if (q.status && q.status !== 'all') {
    where += ' AND o.status = ?';
    params.push(String(q.status));
  }
  if (q.from) {
    where += ' AND o.created_at >= ?';
    params.push(Number(q.from));
  }
  if (q.to) {
    where += ' AND o.created_at < ?';
    params.push(Number(q.to));
  }
  if (q.keyword) {
    where += ' AND (o.order_no LIKE ? OR o.table_no LIKE ? OR o.pickup_no LIKE ?)';
    const kw = '%' + String(q.keyword).slice(0, 32) + '%';
    params.push(kw, kw, kw);
  }

  const page = Math.min(10000, Math.max(1, Number(q.page) || 1));
  const size = Math.min(100, Math.max(1, Number(q.size) || 30));
  const totalRow = await db.queryOne(`SELECT COUNT(*) AS c FROM mp_order o ${where}`, params);
  const rows = await db.query(
    `SELECT o.*, s.name AS shop_name FROM mp_order o LEFT JOIN mp_store s ON s.id = o.store_id
     ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
    params.concat([size, (page - 1) * size])
  );
  const list = await attachItems(rows);
  return ctx.ok({ list, total: Number(totalRow.c), page, size });
}

async function getOrder(ctx) {
  const row = await db.queryOne(
    'SELECT o.*, s.name AS shop_name FROM mp_order o LEFT JOIN mp_store s ON s.id = o.store_id WHERE o.id = ?',
    [String(ctx.params.id || '')]
  );
  if (!row) throw notFound('订单不存在');
  const list = await attachItems([row]);
  return ctx.ok(list[0]);
}

/** 批量装配明细（避免 N+1） */
async function attachItems(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const items = await db.query(`SELECT * FROM mp_order_item WHERE order_id IN (${ph}) ORDER BY id ASC`, ids);
  const grouped = new Map();
  items.forEach((i) => {
    if (!grouped.has(i.order_id)) grouped.set(i.order_id, []);
    grouped.get(i.order_id).push(i);
  });
  return rows.map((r) => {
    const dto = orderRoute.toOrderDTO(r, grouped.get(r.id) || [], []);
    dto.urgeCount = r.urge_count;
    dto.rated = !!r.rated;
    return dto;
  });
}

/* ============================================================ 订单 */
async function advanceOrder(ctx) {
  const b = ctx.body || {};
  const action = String(b.action || '');
  if (!ACTIONS[action]) throw bizError(CODES.PARAM_INVALID, '未知的流转动作：' + action);

  const orderId = String(ctx.params.id || '');
  const order = await db.queryOne('SELECT * FROM mp_order WHERE id = ?', [orderId]);
  if (!order) throw notFound('订单不存在');

  /* 复用管理端同一份流转规则（含跳步校验与完成发积分） */
  const flow = require('./flow');
  const r = await flow.advance({ orderId, action, staffId: b.staffId });
  return ctx.ok(r);
}

async function rejectOrder(ctx) {
  const b = ctx.body || {};
  const orderId = String(ctx.params.id || '');
  const flow = require('./flow');
  const r = await flow.reject({ orderId, reason: String(b.reason || '商家拒单').slice(0, 100), staffId: b.staffId });
  return ctx.ok(r);
}

/* ============================================================ 退款 */
async function approveRefund(ctx) {
  const id = Number(ctx.params.id);
  const flow = require('./flow');
  return ctx.ok(await flow.approveRefund({ refundId: id, staffId: (ctx.body || {}).staffId }));
}

async function rejectRefund(ctx) {
  const id = Number(ctx.params.id);
  const flow = require('./flow');
  return ctx.ok(await flow.rejectRefund({ refundId: id, staffId: (ctx.body || {}).staffId }));
}

/* ============================================================ 团购券 */
/** 店员代客核销：与小程序端自助核销共用 voucherService，防重规则完全一致 */
async function verifyVoucher(ctx) {
  const b = ctx.body || {};
  const storeId = String(b.storeId || '').slice(0, 32);
  if (!storeId) throw bizError(CODES.PARAM_INVALID, '请选择核销门店');
  const store = await db.queryOne('SELECT * FROM mp_store WHERE id = ?', [storeId]);
  if (!store) throw notFound('门店不存在');

  const result = await voucherService.verifyVoucher({
    code: b.code,
    storeId,
    channel: 'STAFF',
    staffId: Number(b.staffId) || 0,
    platform: String(b.platform || 'MEITUAN').slice(0, 16),
  });
  logger.info('voucher verified via internal', {
    storeId,
    code: String(result.code).slice(0, 4) + '****',
    staffId: b.staffId || 0,
  });
  return ctx.ok(result);
}

async function refundVoucher(ctx) {
  const id = Number(ctx.params.id);
  if (!id) throw bizError(CODES.PARAM_INVALID, '核销记录 id 非法');
  return ctx.ok(await voucherService.refundVoucher(id, Number((ctx.body || {}).staffId) || 0));
}

/* ============================================================ 优惠券 */
/** 定向发放：复用小程序端 receive()，防超发与限领规则完全一致 */
async function grantCoupon(ctx) {
  const b = ctx.body || {};
  const couponId = String(ctx.params.id || '');
  if (!couponId) throw bizError(CODES.PARAM_INVALID, '请选择优惠券');

  const userIds = [];
  if (Array.isArray(b.userIds)) userIds.push.apply(userIds, b.userIds.map((x) => Number(x)).filter((n) => n > 0));
  if (Array.isArray(b.phones) && b.phones.length) {
    const ph = b.phones.map(() => '?').join(',');
    const rows = await db.query(`SELECT id FROM mp_user WHERE phone IN (${ph})`, b.phones.map((p) => String(p).slice(0, 32)));
    rows.forEach((r) => userIds.push(Number(r.id)));
  }
  if (Array.isArray(b.openids) && b.openids.length) {
    const ph = b.openids.map(() => '?').join(',');
    const rows = await db.query(`SELECT id FROM mp_user WHERE openid IN (${ph})`, b.openids.map((p) => String(p).slice(0, 64)));
    rows.forEach((r) => userIds.push(Number(r.id)));
  }
  const uniq = Array.from(new Set(userIds)).slice(0, 500);
  if (!uniq.length) throw bizError(CODES.PARAM_INVALID, '未匹配到任何用户（支持用户 id / 手机号 / openid）');

  const results = await couponService.grantToUsers(uniq, couponId, Number(b.operatorId) || 0);
  const okCount = results.filter((r) => r.ok).length;
  logger.info('coupon granted via internal', { couponId, total: uniq.length, ok: okCount });
  return ctx.ok({ total: uniq.length, success: okCount, results });
}

/* ============================================================ 门店菜品 */
async function updateStoreDishes(ctx) {
  const b = ctx.body || {};
  const storeId = String(b.storeId || '');
  if (!storeId) throw bizError(CODES.PARAM_INVALID, '请指定门店');
  const items = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
  if (!items.length) throw bizError(CODES.PARAM_INVALID, '没有需要更新的菜品');

  let updated = 0;
  await db.tx(async (tx) => {
    for (const it of items) {
      const dishId = String(it.dishId || '').slice(0, 32);
      if (!dishId) continue;
      const fields = [];
      const params = [];
      if (it.stock !== undefined) {
        fields.push('stock = ?');
        params.push(Math.max(0, Math.trunc(Number(it.stock) || 0)));
      }
      if (it.status !== undefined) {
        fields.push('status = ?');
        params.push(it.status ? 1 : 0);
      }
      if (it.priceOverride !== undefined) {
        fields.push('price_override = ?');
        params.push(Math.max(0, Math.trunc(Number(it.priceOverride) || 0)));
      }
      if (!fields.length) continue;
      fields.push('updated_at = ?');
      params.push(Date.now());
      params.push(storeId, dishId);
      const r = await tx.execute(
        `UPDATE mp_store_dish SET ${fields.join(', ')} WHERE store_id = ? AND dish_id = ?`,
        params
      );
      if (r.affectedRows > 0) updated++;
    }
  });
  await menuRoute.refreshMenuCache(storeId);
  return ctx.ok({ ok: true, updated });
}

async function toggleStoreDish(ctx) {
  const b = ctx.body || {};
  const dishId = String(ctx.params.id || '');
  const storeId = String(b.storeId || '');
  if (!storeId) throw bizError(CODES.PARAM_INVALID, '请指定门店');
  const r = await db.execute('UPDATE mp_store_dish SET status = ?, updated_at = ? WHERE store_id = ? AND dish_id = ?', [
    b.status ? 1 : 0, Date.now(), storeId, dishId,
  ]);
  if (r.affectedRows === 0) throw notFound('该门店未配置此菜品，请先同步菜单');
  await menuRoute.refreshMenuCache(storeId);
  return ctx.ok({ ok: true });
}

/* ============================================================ 缓存 */
async function invalidateMenuCache(ctx) {
  const storeId = String((ctx.body || {}).storeId || '');
  await menuRoute.refreshMenuCache(storeId);
  return ctx.ok({ ok: true });
}

/* ============================================================ 在线客服（管理端） */
/**
 * 管理端查看/回复客服工单。
 * 为什么回复逻辑放在这里而不是管理端自己写 INSERT：
 * 工单的未读数、最后消息预览、会话状态是「一套一致性规则」，
 * 复制到管理端就会出现「回复了但用户端未读数不涨」这类脏数据。
 */
async function listServiceTickets(ctx) {
  const q = ctx.query || {};
  const status = q.status === 'CLOSED' ? 'CLOSED' : q.status === 'all' ? '' : 'OPEN';
  const size = Math.min(Math.max(Number(q.size || 50), 1), 100);

  const params = [];
  let where = 'WHERE 1=1';
  if (status) {
    where += ' AND t.status = ?';
    params.push(status);
  }
  const storeIds = String(q.storeIds || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  /* 门店范围：未指定门店的会话（用户没选店）对所有客服可见，避免消息没人管 */
  if (storeIds.length) {
    where += ` AND (t.store_id = '' OR t.store_id IN (${storeIds.map(() => '?').join(',')}))`;
    params.push.apply(params, storeIds);
  }
  params.push(size);

  const rows = await db.query(
    `SELECT t.*, u.nickname, u.avatar, u.phone
     FROM mp_service_ticket t LEFT JOIN mp_user u ON u.id = t.user_id
     ${where} ORDER BY t.admin_unread DESC, t.updated_at DESC LIMIT ?`,
    params
  );
  return ctx.ok({
    list: rows.map((r) => ({
      id: Number(r.id),
      userId: Number(r.user_id),
      storeId: r.store_id,
      status: r.status,
      lastMsgAt: Number(r.last_msg_at),
      lastPreview: r.last_preview,
      adminUnread: Number(r.admin_unread),
      userUnread: Number(r.user_unread),
      createdAt: Number(r.created_at),
      nickname: r.nickname || '微信用户',
      avatar: r.avatar || '',
      phoneMask: r.phone ? r.phone.slice(0, 3) + '****' + r.phone.slice(-4) : '',
    })),
    total: rows.length,
  });
}

async function getServiceTicket(ctx) {
  const id = Number(ctx.params.id);
  const ticket = await db.queryOne('SELECT * FROM mp_service_ticket WHERE id = ?', [id]);
  if (!ticket) throw notFound('会话不存在');
  const rows = await db.query('SELECT * FROM mp_service_message WHERE ticket_id = ? ORDER BY id ASC LIMIT 300', [id]);
  /* 客服打开即已读 */
  if (ticket.admin_unread) await db.execute('UPDATE mp_service_ticket SET admin_unread = 0 WHERE id = ?', [id]);
  const user = await db.queryOne('SELECT nickname, avatar, phone FROM mp_user WHERE id = ?', [ticket.user_id]);
  return ctx.ok({
    ticket: {
      id: Number(ticket.id),
      userId: Number(ticket.user_id),
      storeId: ticket.store_id,
      status: ticket.status,
      createdAt: Number(ticket.created_at),
      nickname: (user && user.nickname) || '微信用户',
      phoneMask: user && user.phone ? user.phone.slice(0, 3) + '****' + user.phone.slice(-4) : '',
    },
    list: rows.map((m) => {
      let meta = {};
      try {
        meta = m.media_meta ? JSON.parse(m.media_meta) : {};
      } catch (e) {}
      return {
        id: Number(m.id),
        sender: m.sender,
        type: m.msg_type,
        content: m.content || '',
        mediaUrl: m.media_url || '',
        meta,
        createdAt: Number(m.created_at),
      };
    }),
  });
}

const TICKET_MSG_TYPES = ['text', 'image', 'video', 'voice', 'file'];
const SVC_SENDERS = ['ADMIN', 'SYSTEM'];

/** 管理端回复（也可发图片/视频/语音/文件：先走 /upload 拿 url，再带 mediaUrl 回复） */
async function replyServiceTicket(ctx) {
  const serviceRoute = require('./service');
  const id = Number(ctx.params.id);
  const ticket = await db.queryOne('SELECT * FROM mp_service_ticket WHERE id = ?', [id]);
  if (!ticket) throw notFound('会话不存在');
  if (ticket.status !== 'OPEN') throw bizError(CODES.STATE_CONFLICT, '会话已结束，无法回复');

  const b = ctx.body || {};
  const sender = SVC_SENDERS.indexOf(String(b.sender)) > -1 ? String(b.sender) : 'ADMIN';
  const type = TICKET_MSG_TYPES.indexOf(String(b.type || 'text')) > -1 ? String(b.type || 'text') : 'text';
  let content = String(b.content == null ? '' : b.content).trim().slice(0, 500);
  let mediaUrl = '';
  let mediaMeta = '';
  if (type === 'text') {
    if (!content) throw bizError(CODES.PARAM_INVALID, '回复内容不能为空');
  } else {
    mediaUrl = String(b.mediaUrl || '');
    if (!/^(\/uploads\/[\w./-]+|https:\/\/[\w./?=&%-]+)$/.test(mediaUrl)) {
      throw bizError(CODES.PARAM_INVALID, '媒体地址不合法');
    }
    mediaMeta = JSON.stringify(b.meta && typeof b.meta === 'object' ? b.meta : {}).slice(0, 480);
    content = content.slice(0, 100);
  }

  const ins = await serviceRoute.insertMessage(id, 0, sender, type, content, mediaUrl, mediaMeta);
  await db.execute(
    `UPDATE mp_service_ticket SET last_msg_at = ?, last_preview = ?, user_unread = user_unread + 1, updated_at = ?
     WHERE id = ?`,
    [ins.now, (sender === 'SYSTEM' ? '[客服助手] ' : '') + ins.preview, ins.now, id]
  );
  logger.info('service replied', { ticketId: id, staffId: b.staffId || 0, type });
  return ctx.ok({ id: ins.id, createdAt: ins.now });
}

async function closeServiceTicket(ctx) {
  const id = Number(ctx.params.id);
  const ticket = await db.queryOne('SELECT * FROM mp_service_ticket WHERE id = ?', [id]);
  if (!ticket) throw notFound('会话不存在');
  const serviceRoute = require('./service');
  const now = Date.now();
  await db.execute("UPDATE mp_service_ticket SET status = 'CLOSED', updated_at = ? WHERE id = ?", [now, id]);
  await serviceRoute.insertMessage(id, 0, 'SYSTEM', 'text', '客服已结束本次会话，如需继续咨询请重新发起。', '', '');
  return ctx.ok({ ok: true });
}

/* ============================================================ 发票管理（管理端） */
async function listInvoiceRecords(ctx) {
  const q = ctx.query || {};
  const status = ['PENDING', 'PROCESSING', 'ISSUED', 'REJECTED'].indexOf(q.status) > -1 ? q.status : '';
  const size = Math.min(Math.max(Number(q.size || 50), 1), 200);
  const params = [];
  let where = 'WHERE 1=1';
  if (status) {
    where += ' AND r.status = ?';
    params.push(status);
  }
  const storeIds = String(q.storeIds || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (storeIds.length) {
    where += ` AND r.store_id IN (${storeIds.map(() => '?').join(',')})`;
    params.push.apply(params, storeIds);
  }
  params.push(size);
  const rows = await db.query(
    `SELECT r.*, u.nickname FROM mp_invoice_request r LEFT JOIN mp_user u ON u.id = r.user_id
     ${where} ORDER BY FIELD(r.status,'PENDING','PROCESSING','ISSUED','REJECTED'), r.applied_at DESC LIMIT ?`,
    params
  );
  return ctx.ok({
    list: rows.map((r) => ({
      id: Number(r.id),
      userId: Number(r.user_id),
      nickname: r.nickname || '',
      orderNo: r.order_no,
      orderId: r.order_id,
      storeId: r.store_id,
      amount: Number(r.amount),
      titleType: r.title_type,
      title: r.title,
      taxNo: r.tax_no,
      email: r.email,
      status: r.status,
      invoiceNo: r.invoice_no || '',
      invoiceUrl: r.invoice_url || '',
      remark: r.remark || '',
      appliedAt: Number(r.applied_at),
      issuedAt: Number(r.issued_at),
    })),
    total: rows.length,
  });
}

/** 受理 / 开具 / 驳回 三态流转（开具后金额、抬头不可再改） */
async function updateInvoiceRecord(ctx) {
  const id = Number(ctx.params.id);
  const row = await db.queryOne('SELECT * FROM mp_invoice_request WHERE id = ?', [id]);
  if (!row) throw notFound('开票申请不存在');
  const b = ctx.body || {};
  const to = String(b.status || '');
  if (['PROCESSING', 'ISSUED', 'REJECTED'].indexOf(to) === -1) {
    throw bizError(CODES.PARAM_INVALID, 'status 仅支持 PROCESSING / ISSUED / REJECTED');
  }
  if (to === 'ISSUED' && !String(b.invoiceNo || '').trim() && !String(b.invoiceUrl || '').trim()) {
    throw bizError(CODES.PARAM_INVALID, '开具发票需填写发票号码或上传发票文件地址');
  }
  const now = Date.now();
  await db.execute(
    `UPDATE mp_invoice_request
     SET status = ?, invoice_no = ?, invoice_url = ?, remark = ?, issued_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      to,
      String(b.invoiceNo || row.invoice_no || '').slice(0, 64),
      String(b.invoiceUrl || row.invoice_url || '').slice(0, 512),
      String(b.remark || '').slice(0, 255),
      to === 'ISSUED' ? now : Number(row.issued_at || 0),
      now,
      id,
    ]
  );
  logger.info('invoice updated', { id, to, staffId: b.staffId || 0 });
  return ctx.ok({ ok: true, status: to });
}

/* ============================================================ 加盟配置（管理端） */
async function getFranchiseConfig(ctx) {
  const contentRoute = require('./content');
  return contentRoute.getFranchise(ctx);
}

async function updateFranchiseConfig(ctx) {
  const b = ctx.body || {};
  const brandId = String(b.brandId || 'brand_lbz').slice(0, 32);
  const fields = [];
  const values = [];
  const map = {
    title: ['title', 64],
    subtitle: ['subtitle', 128],
    posterUrl: ['poster_url', 512],
    qrUrl: ['qr_url', 512],
    qrTip: ['qr_tip', 128],
    consultPhone: ['consult_phone', 32],
    wecomId: ['wecom_id', 64],
  };
  Object.keys(map).forEach((k) => {
    if (b[k] === undefined) return;
    const [col, max] = map[k];
    const val = String(b[k] == null ? '' : b[k]).trim().slice(0, max);
    if ((col === 'poster_url' || col === 'qr_url') && val && !/^(https:\/\/|\/uploads\/)/.test(val)) {
      throw bizError(CODES.PARAM_INVALID, '图片地址必须为 https 或本站上传路径');
    }
    fields.push(col + ' = ?');
    values.push(val);
  });
  if (b.highlights !== undefined) {
    if (!Array.isArray(b.highlights)) throw bizError(CODES.PARAM_INVALID, 'highlights 必须是数组');
    const slim = b.highlights.slice(0, 8).map((h) => ({
      icon: String((h && h.icon) || '').slice(0, 4),
      label: String((h && h.label) || '').slice(0, 16),
      value: String((h && h.value) || '').slice(0, 24),
    }));
    fields.push('highlights = ?');
    values.push(JSON.stringify(slim).slice(0, 1024));
  }
  if (!fields.length) throw bizError(CODES.PARAM_INVALID, '没有需要更新的字段');

  const exist = await db.queryOne('SELECT id FROM mp_franchise_config WHERE brand_id = ? LIMIT 1', [brandId]);
  values.push(Date.now());
  if (!exist) {
    await db.execute(
      `INSERT INTO mp_franchise_config (id, brand_id, title, subtitle, highlights, poster_url, qr_url, qr_tip, consult_phone, wecom_id, updated_at)
       VALUES (?,?,'老北京麻辣串串香 · 加盟合作','','[]','','','','','',?)`,
      [brandId, brandId, Date.now()]
    );
  }
  await db.execute(`UPDATE mp_franchise_config SET ${fields.join(', ')}, updated_at = ? WHERE brand_id = ?`, values.concat([brandId]));
  return ctx.ok({ ok: true });
}

/* ============================================================ 协议维护（管理端） */
async function listAgreementsAdmin(ctx) {
  /* 带上正文：协议只有个位数条，一次取全便于后台直接编辑，不做无意义的分次请求 */
  const rows = await db.query(
    'SELECT code, title, summary, content_html, version, sort, status, updated_at FROM mp_agreement ORDER BY sort ASC, id ASC'
  );
  return ctx.ok({
    list: rows.map((r) => ({
      code: r.code,
      title: r.title,
      summary: r.summary,
      contentHtml: r.content_html || '',
      version: r.version,
      sort: Number(r.sort),
      status: Number(r.status),
      updatedAt: Number(r.updated_at),
    })),
  });
}

async function updateAgreement(ctx) {
  const code = String(ctx.params.code || '').slice(0, 32);
  const row = await db.queryOne('SELECT * FROM mp_agreement WHERE code = ?', [code]);
  if (!row) throw notFound('协议不存在');
  const b = ctx.body || {};
  const fields = [];
  const values = [];
  if (b.title !== undefined) {
    const t = String(b.title).trim().slice(0, 64);
    if (!t) throw bizError(CODES.PARAM_INVALID, '标题不能为空');
    fields.push('title = ?');
    values.push(t);
  }
  if (b.summary !== undefined) {
    fields.push('summary = ?');
    values.push(String(b.summary).trim().slice(0, 200));
  }
  if (b.contentHtml !== undefined) {
    const html = String(b.contentHtml || '');
    if (html.length > 200000) throw bizError(CODES.PARAM_INVALID, '正文过长（上限 200KB）');
    /* rich-text 只渲染白名单标签；这里再做一层脚本剥离，避免管理员误粘贴带 <script> 的文档 */
    fields.push('content_html = ?');
    values.push(html.replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '').replace(/on\w+\s*=\s*"[^"]*"/gi, ''));
  }
  if (b.version !== undefined) {
    fields.push('version = ?');
    values.push(String(b.version).trim().slice(0, 16) || 'v1.0');
  }
  if (b.sort !== undefined) {
    fields.push('sort = ?');
    values.push(Number(b.sort) || 0);
  }
  if (b.status !== undefined) {
    fields.push('status = ?');
    values.push(b.status ? 1 : 0);
  }
  if (!fields.length) throw bizError(CODES.PARAM_INVALID, '没有需要更新的字段');
  values.push(Date.now());
  values.push(code);
  await db.execute(`UPDATE mp_agreement SET ${fields.join(', ')}, updated_at = ? WHERE code = ?`, values);
  return ctx.ok({ ok: true });
}

module.exports = {
  listOrders,
  getOrder,
  advanceOrder,
  rejectOrder,
  approveRefund,
  rejectRefund,
  verifyVoucher,
  refundVoucher,
  grantCoupon,
  updateStoreDishes,
  toggleStoreDish,
  invalidateMenuCache,
  listServiceTickets,
  getServiceTicket,
  replyServiceTicket,
  closeServiceTicket,
  listInvoiceRecords,
  updateInvoiceRecord,
  getFranchiseConfig,
  updateFranchiseConfig,
  listAgreementsAdmin,
  updateAgreement,
};
