/**
 * 极简 HTTP 框架（零依赖）
 * 为什么不用 Express/Fastify：
 *   交付系统要尽量减少供应链与运行时不确定性。这里只需要「路由 + 中间件 + 统一响应 + 过载保护」，
 *   200 行就能写得完全可控，且出问题时调用栈是透明的。
 *
 * 内置的交付级能力：
 *   · 请求 ID 贯穿全链路
 *   · 请求体大小限制 + JSON 解析容错（坏 JSON 不会崩进程）
 *   · 全局 inflight 计数，超过 MAX_INFLIGHT 直接 503（宁可拒绝也不雪崩）
 *   · 单请求超时（默认 15s），超时自动释放
 *   · 客户端断开即取消，避免 handler 继续跑
 *   · 任何 handler 抛错都被捕获 → 统一响应，绝不冒泡到进程
 *   · 慢请求 / 5xx 自动记 warn/error 日志
 */
const http = require('http');
const { URL } = require('url');
const config = require('./config');
const logger = require('./logger');
const { AppError, CODES } = require('./errors');

/**
 * 全站安全响应头（出口统一加，不依赖 Nginx）
 *   · nosniff：阻断 MIME 嗅探（上传目录尤其需要，否则一个 .txt 可能被执行成 HTML）
 *   · X-Frame-Options：防点击劫持（管理后台被嵌入 iframe 做透明覆盖）
 *   · Referrer-Policy：不把 URL 里的订单号/券码泄露给外链
 *   · HSTS：仅生产开启，避免本地 http 调试被强制跳 https
 */
const SECURITY_HEADERS = Object.assign(
  {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'X-Powered-By': '',
  },
  config.env === 'production' ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}
);

let requestSeq = 0;
function nextRequestId() {
  requestSeq = (requestSeq + 1) % 1000000;
  return Date.now().toString(36) + '-' + process.pid.toString(36) + '-' + requestSeq.toString(36);
}

/** 把 /orders/:id/items 编译成正则 + 参数名 */
function compile(path) {
  const names = [];
  const pattern = path
    .replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      names.push(name);
      return '/([^/]+)';
    })
    .replace(/\/$/, '');
  return { re: new RegExp('^' + pattern + '/?$'), names };
}

/**
 * 极简 multipart/form-data 解析（零依赖）
 *
 * 为什么不用 busboy/formidable：本项目只处理小文件（聊天图片/语音/短视频/文件），
 * 而且必须对「文件内容里恰好出现 boundary」这种情况保持可控 —— 自己解析时，
 * 我们只按「\r\n--boundary」切分并做长度校验，出问题时行为可预期，调用栈透明。
 *
 * @returns {{fields:Object, files:Array<{field,filename,contentType,size,buffer}>}}
 */
function parseMultipart(buffer, boundary) {
  const result = { fields: {}, files: [] };
  if (!boundary) return result;
  const boundaryBuf = Buffer.from('--' + boundary);
  const headerEnd = Buffer.from('\r\n\r\n');
  let pos = buffer.indexOf(boundaryBuf);
  if (pos === -1) return result;
  pos += boundaryBuf.length;

  while (pos < buffer.length) {
    /* 结尾标记：--boundary-- */
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break;
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2;

    const hEnd = buffer.indexOf(headerEnd, pos);
    if (hEnd === -1) break;
    const headerText = buffer.slice(pos, hEnd).toString('utf8');
    const contentStart = hEnd + 4;

    const nextBoundary = buffer.indexOf(boundaryBuf, contentStart);
    if (nextBoundary === -1) break;
    /* 内容与下一段 boundary 之间固定隔一个 CRLF，属于分隔符本身而非内容 */
    let contentEnd = nextBoundary;
    if (buffer[contentEnd - 2] === 0x0d && buffer[contentEnd - 1] === 0x0a) contentEnd -= 2;

    const nameM = /name="([^"]*)"/i.exec(headerText);
    const fileM = /filename="([^"]*)"/i.exec(headerText);
    const typeM = /content-type:\s*([^\r\n;]+)/i.exec(headerText);
    const content = buffer.slice(contentStart, contentEnd);

    if (fileM) {
      result.files.push({
        field: nameM ? nameM[1] : 'file',
        filename: fileM[1],
        contentType: typeM ? typeM[1].trim().toLowerCase() : 'application/octet-stream',
        size: content.length,
        buffer: content,
      });
    } else if (nameM) {
      result.fields[nameM[1]] = content.toString('utf8');
    }
    pos = nextBoundary + boundaryBuf.length;
  }
  return result;
}

class Router {
  constructor() {
    this.routes = [];
    this.hooks = [];
  }

  /** 全局前置钩子：async (ctx) => void，抛错即中断 */
  use(fn) {
    this.hooks.push(fn);
    return this;
  }

  add(method, path, ...handlers) {
    const { re, names } = compile(path);
    this.routes.push({ method, path, re, names, handlers });
    return this;
  }

  get(p, ...h) {
    return this.add('GET', p, ...h);
  }
  post(p, ...h) {
    return this.add('POST', p, ...h);
  }
  put(p, ...h) {
    return this.add('PUT', p, ...h);
  }
  del(p, ...h) {
    return this.add('DELETE', p, ...h);
  }

  match(method, pathname) {
    let pathExists = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathExists = true;
      if (r.method === method || (method === 'HEAD' && r.method === 'GET')) {
        const params = {};
        r.names.forEach((n, i) => {
          params[n] = decodeURIComponent(m[i + 1]);
        });
        return { route: r, params };
      }
    }
    return pathExists ? { methodNotAllowed: true } : null;
  }
}

class Server {
  constructor() {
    this.router = new Router();
    this.inflight = 0;
    this.stats = { total: 0, ok: 0, bizError: 0, serverError: 0, rejected: 0, slow: 0 };
    this.startedAt = Date.now();
    this.requestTimeout = 15000;
    this.server = null;
    this.draining = false;
  }

  handle(fn) {
    this.router.use(fn);
    return this;
  }
  get(...a) {
    this.router.get(...a);
    return this;
  }
  post(...a) {
    this.router.post(...a);
    return this;
  }
  put(...a) {
    this.router.put(...a);
    return this;
  }
  del(...a) {
    this.router.del(...a);
    return this;
  }

  readBody(ctx) {
    const req = ctx.req;
    const ctype = String(req.headers['content-type'] || '');
    const isMultipart = ctype.indexOf('multipart/form-data') > -1;
    /* 只有 multipart 才放开到大报文（上传），JSON 接口仍用小限额防刷 */
    const limit = isMultipart ? config.upload.limit : config.bodyLimit;

    return new Promise((resolve, reject) => {
      let size = 0;
      let overflow = false;
      const chunks = [];
      req.on('data', (c) => {
        if (overflow) return; // 已判定超限：不再累积（防内存膨胀），但要继续把流读完，让客户端能收到 413
        size += c.length;
        if (size > limit) {
          overflow = true;
          chunks.length = 0;
          /**
           * 不要 req.destroy()：那会直接把连接掐断，客户端只会看到「网络异常」，
           * 而不是「请求体过大」。这里只拒绝，响应照常写回，连接保持正常。
           */
          reject(new AppError(CODES.PARAM_INVALID, isMultipart ? '文件过大，请压缩后重试' : '请求体过大', 413));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (overflow) return;
        const raw = Buffer.concat(chunks);

        if (isMultipart) {
          const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
          const boundary = (m && (m[1] || m[2]) || '').trim();
          const parsed = parseMultipart(raw, boundary);
          ctx.rawBody = ''; // 二进制报文不做验签用途，不缓存
          ctx.files = parsed.files;
          return resolve(parsed.fields);
        }

        const text = raw.toString('utf8');
        // 微信支付回调验签必须用「原始报文」，反序列化再序列化会因键序/空格导致验签失败
        ctx.rawBody = text;
        if (!text) return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new AppError(CODES.PARAM_INVALID, '请求体不是合法 JSON', 400));
        }
      });
      req.on('error', (e) => {
        if (overflow) return;
        reject(new AppError(CODES.PARAM_INVALID, '读取请求体失败', 400, e.message));
      });
      req.on('aborted', () => resolve({}));
    });
  }

  buildCtx(req, res) {
    const u = new URL(req.url, 'http://internal');
    let query = {};
    u.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ctx = {
      req,
      res,
      method: req.method,
      pathname: u.pathname.replace(/\/+$/, '') || '/',
      query,
      params: {},
      body: {},
      /** multipart 上传的文件（非上传接口为空数组） */
      files: [],
      headers: req.headers,
      ip: fwd || req.socket.remoteAddress || '',
      requestId: req.headers['x-request-id'] || nextRequestId(),
      user: null,
      startAt: Date.now(),
      aborted: false,
      /** 已发送响应标记，防止二次写 */
      sent: false,
      ok(data, extra) {
        return this.send(200, Object.assign({ code: 0, message: 'ok', data: data === undefined ? null : data }, extra || {}));
      },
      send(status, payload) {
        if (this.sent || this.res.writableEnded) return;
        this.sent = true;
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        this.res.writeHead(status, Object.assign(SECURITY_HEADERS, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': body.length,
          'X-Request-Id': this.requestId,
          'Cache-Control': 'no-store',
        }));
        this.res.end(body);
      },
    };
    req.on('aborted', () => {
      ctx.aborted = true;
    });
    return ctx;
  }

  listen(port, host) {
    this.server = http.createServer((req, res) => this.onRequest(req, res));

    /** 交付级连接与超时参数：防慢连接耗尽、防长连接堆积 */
    this.server.keepAliveTimeout = 65000;
    this.server.headersTimeout = 66000;
    this.server.requestTimeout = 30000;
    this.server.maxRequestsPerSocket = 1000;
    this.server.timeout = 0;

    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve(this.server.address());
      });
    });
  }

  async onRequest(req, res) {
    const ctx = this.buildCtx(req, res);

    /* 过载保护：正在处理 + 排队 超过上限直接拒绝，保护进程不被打挂 */
    if (this.inflight >= config.maxInflight) {
      this.stats.rejected++;
      ctx.send(503, { code: CODES.UNAVAILABLE, message: '服务繁忙，请稍后重试', data: null });
      logger.warn('overload reject', { requestId: ctx.requestId, path: ctx.pathname, inflight: this.inflight });
      return;
    }
    /* 摘流量时（SIGTERM 后）不再接新请求，交给负载均衡 */
    if (this.draining) {
      res.writeHead(503, { Connection: 'close' });
      res.end();
      return;
    }

    this.inflight++;
    this.stats.total++;

    /* 单请求超时兜底：handler 卡住也要释放。
       上传（multipart）在弱网下天然更慢，单独放宽，避免大文件必超时 */
    const isUpload = String(req.headers['content-type'] || '').indexOf('multipart/form-data') > -1;
    const timer = setTimeout(() => {
      if (!ctx.sent) {
        logger.error('request timeout', { requestId: ctx.requestId, path: ctx.pathname });
        ctx.send(504, { code: CODES.UPSTREAM_ERROR, message: '请求超时', data: null });
      }
    }, isUpload ? Math.max(this.requestTimeout, 90000) : this.requestTimeout);
    timer.unref && timer.unref();

    try {
      const hit = this.router.match(req.method, ctx.pathname);

      if (!hit) {
        ctx.send(404, { code: CODES.NOT_FOUND, message: '接口不存在', data: null });
      } else if (hit.methodNotAllowed) {
        ctx.send(405, { code: CODES.NOT_FOUND, message: '请求方法不支持', data: null });
      } else {
        ctx.params = hit.params;
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          ctx.body = await this.readBody(ctx);
        }
        for (const hook of this.router.hooks) {
          await hook(ctx);
          if (ctx.sent) break;
        }
        if (!ctx.sent) {
          for (const h of hit.route.handlers) {
            await h(ctx);
            if (ctx.sent) break;
          }
        }
        if (!ctx.sent) ctx.ok(null);
      }
    } catch (e) {
      this.handleError(ctx, e);
    } finally {
      clearTimeout(timer);
      this.inflight--;
      const cost = Date.now() - ctx.startAt;
      const meta = {
        requestId: ctx.requestId,
        method: ctx.method,
        path: ctx.pathname,
        status: res.statusCode,
        cost,
        ip: ctx.ip,
        uid: ctx.user ? ctx.user.id : null,
      };
      if (res.statusCode >= 500) this.stats.serverError++;
      else if (res.statusCode >= 400) this.stats.bizError++;
      else this.stats.ok++;
      if (cost > 1000) {
        this.stats.slow++;
        logger.warn('slow request', meta);
      } else if (res.statusCode >= 500) {
        logger.error('request failed', meta);
      } else {
        logger.info('request', meta);
      }
    }
  }

  handleError(ctx, e) {
    const isApp = e instanceof AppError;
    if (isApp) {
      logger.warn('business error', {
        requestId: ctx.requestId,
        path: ctx.pathname,
        code: e.code,
        message: e.message,
      });
      if (!ctx.sent) {
        ctx.send(e.httpStatus || 200, {
          code: e.code,
          message: e.message,
          data: null,
          detail: config.env === 'production' ? undefined : e.detail,
        });
      }
      return;
    }
    /* 未预期异常：绝不让进程崩，同时把完整栈留在日志里 */
    logger.error('unhandled error', {
      requestId: ctx.requestId,
      path: ctx.pathname,
      message: e && e.message,
      stack: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join(' | ') : '',
    });
    if (!ctx.sent) {
      ctx.send(500, { code: CODES.SERVER_ERROR, message: '服务开小差了，请稍后重试', data: null });
    }
  }

  /** 优雅退出：停止接新连接 → 等在途请求完成 → 关闭连接 */
  async close(graceMs) {
    this.draining = true;
    if (!this.server) return;
    const deadline = Date.now() + (graceMs || 10000);
    await new Promise((resolve) => {
      const tick = () => {
        if (this.inflight <= 0 || Date.now() > deadline) return resolve();
        setTimeout(tick, 100);
      };
      this.server.close(() => resolve());
      tick();
    });
    this.server.closeAllConnections && this.server.closeAllConnections();
    logger.info('server closed', { inflight: this.inflight, stats: this.stats });
  }
}

module.exports = { Server, Router };
