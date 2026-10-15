
(function () {
  'use strict';
  /**
   * 配置：管理系统后端 base URL
   *
   * 注意：页面内的接口路径统一以 /admin/ 开头（如 api('/admin/auth/login')），
   * 所以 base 只需写到 /miniapp/v1，最终 URL = /miniapp/v1/admin/auth/login。
   * 千万不要把 base 写成 /miniapp/v1/admin —— 会拼出双重 /admin/admin/ 导致 404。
   *
   * 同源部署：走默认相对路径（Nginx 把 /miniapp/v1/admin 反代到 admin-server:3001）
   * 前后端分域：改为绝对地址，例如
   *   var API = 'https://admin-api.example.com/miniapp/v1';
   * 也可由部署时替换占位符 __ADMIN_API_BASE__。
   */
  var API = (window.__ADMIN_API_BASE__ || '/miniapp/v1');
  var LS = { token: 'lbz_staff_token', refresh: 'lbz_staff_refresh', staff: 'lbz_staff_info' };

  var S = {
    staff: null,          // 当前登录员工（含 perms / scope）
    stores: [],           // 可用门店
    storeId: '',          // 全局选中的门店（''=全部门店，仅超管可全选）
    view: 'dashboard',
    cache: {},
  };

  /* ============ 基础工具 ============ */
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fen(n) { return (Number(n || 0) / 100).toFixed(2); }
  function toast(m) { var e = el('toast'); e.textContent = m; e.classList.add('on'); clearTimeout(e._t); e._t = setTimeout(function () { e.classList.remove('on'); }, 2000); }
  function fmtTime(ts) { return ts ? new Date(Number(ts)).toLocaleString('zh-CN') : ''; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function has(perm) {
    if (!S.staff) return false;
    var p = S.staff.perms || [];
    return p.indexOf('*') > -1 || p.indexOf(perm) > -1;
  }

  /* ============ 请求层（含 401 自动刷新令牌） ============ */
  var refreshing = null;
  function raw(path, opt) {
    opt = opt || {};
    var h = { 'Content-Type': 'application/json' };
    var t = localStorage.getItem(LS.token);
    if (t) h.Authorization = 'Bearer ' + t;
    return fetch(API + path, {
      method: opt.method || 'GET',
      headers: Object.assign(h, opt.headers || {}),
      body: opt.body ? JSON.stringify(opt.body) : undefined,
      /* 不带超时会有一个请求永远挂着、页面一直转圈的情况 */
      signal: opt.signal || (AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined),
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, j: j }; }, function () { return { status: r.status, j: { code: -999, message: '响应解析失败' } }; });
    });
  }
  function doRefresh() {
    if (!refreshing) {
      var rt = localStorage.getItem(LS.refresh);
      refreshing = fetch(API + '/admin/auth/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: rt }),
      }).then(function (r) { return r.json(); }).then(function (j) {
        refreshing = null;
        if (j.code !== 0) throw j;
        localStorage.setItem(LS.token, j.data.access_token);
        localStorage.setItem(LS.refresh, j.data.refresh_token);
        S.staff = j.data.staff;
        return j.data;
      }, function (e) { refreshing = null; throw e; });
    }
    return refreshing;
  }
  function api(path, opt) {
    opt = opt || {};
    return raw(path, opt).then(function (res) {
      /**
       * 401 → 刷新令牌后重放一次，且**只重放一次**。
       * 没有 __retried 兜底的话，若刷新成功但令牌仍不可用（被吊销/账号停用），
       * 会陷入「401 → 刷新 → 401 → 刷新」的死循环，页面直接卡死。
       */
      if (res.status === 401 && !opt.__retried) {
        return doRefresh().then(function () {
          return api(path, Object.assign({}, opt, { __retried: true }));
        });
      }
      if (res.status === 401) logout();
      if (res.j.code !== 0) throw res.j;
      return res.j.data;
    });
  }

  /* ============ 弹窗 ============ */
  function modal(title, bodyHtml, onOk, okText) {
    el('modalRoot').innerHTML =
      '<div class="mask"><div class="modal"><h3>' + esc(title) + '</h3><div id="mbody">' + bodyHtml + '</div>' +
      '<div class="foot"><button class="btn" id="mCancel">取消</button>' +
      (onOk ? '<button class="btn btn-p" id="mOk">' + esc(okText || '确定') + '</button>' : '') +
      '</div></div></div>';
    el('mCancel').onclick = function () { el('modalRoot').innerHTML = ''; };
    if (onOk && el('mOk')) el('mOk').onclick = function () {
      var r = onOk();
      if (r !== false) el('modalRoot').innerHTML = '';
    };
  }
  function closeModal() { el('modalRoot').innerHTML = ''; }

  /* ============ 登录页 ============ */
  function renderLogin(msg) {
    el('root').innerHTML =
      '<div class="login"><div class="box">' +
      '<h1>🌶️ 老北京麻辣串串香</h1><p>连锁运营管理后台 v1.0</p>' +
      '<label class="f"><span>登录账号</span><input type="text" id="ac" placeholder="如 admin" autocomplete="username"></label>' +
      '<label class="f"><span>登录密码</span><input type="password" id="pw" placeholder="请输入密码" autocomplete="current-password"></label>' +
      (msg ? '<div style="color:#c62828;font-size:12.5px;margin-bottom:8px">' + esc(msg) + '</div>' : '') +
      '<button class="btn btn-p" id="doLogin">登 录</button>' +
      '<div class="hint">演示账号（首次登录需改密）：<br>' +
      '品牌超管 <b>admin / Admin@123456</b><br>' +
      '区域经理 <b>region_north / Region@123456</b><br>' +
      '店长 <b>mgr_dz / Store@123456</b> · 店员 <b>staff_dz / Staff@123456</b><br>' +
      '加盟商 <b>owner_ft / Franchise@123456</b></div>' +
      '</div></div>';
    el('doLogin').onclick = function () {
      var account = el('ac').value.trim();
      var password = el('pw').value;
      if (!account || !password) return toast('请输入账号和密码');
      el('doLogin').disabled = true;
      api('/admin/auth/login', { method: 'POST', body: { account: account, password: password } })
        .then(function (d) {
          localStorage.setItem(LS.token, d.access_token);
          localStorage.setItem(LS.refresh, d.refresh_token);
          S.staff = d.staff;
          boot();
        })
        .catch(function (e) {
          el('doLogin').disabled = false;
          renderLogin(e && e.message);
        });
    };
    el('pw').onkeydown = function (e) { if (e.key === 'Enter') el('doLogin').click(); };
  }

  /* ============ 改密（首登强制） ============ */
  function renderForcePwd() {
    el('root').innerHTML =
      '<div class="login"><div class="box">' +
      '<h1>🔒 请先修改初始密码</h1><p>为了账号安全，首次登录必须修改密码（至少 8 位，含字母和数字）</p>' +
      '<label class="f"><span>原密码</span><input type="password" id="op"></label>' +
      '<label class="f"><span>新密码</span><input type="password" id="np"></label>' +
      '<label class="f"><span>确认新密码</span><input type="password" id="np2"></label>' +
      '<button class="btn btn-p" id="doPwd">提交</button>' +
      '<div class="hint">当前账号：' + esc(S.staff.account) + ' · ' + esc(S.staff.roleName) + '</div>' +
      '</div></div>';
    el('doPwd').onclick = function () {
      var op = el('op').value, np = el('np').value, np2 = el('np2').value;
      if (np !== np2) return toast('两次输入的新密码不一致');
      api('/admin/auth/password', { method: 'POST', body: { oldPassword: op, newPassword: np } })
        .then(function () { toast('密码已修改，请重新登录'); logout(); })
        .catch(function (e) { toast((e && e.message) || '修改失败'); });
    };
  }

  function logout() {
    api('/admin/auth/logout', { method: 'POST' }).catch(function () {});
    localStorage.removeItem(LS.token);
    localStorage.removeItem(LS.refresh);
    S.staff = null;
    renderLogin();
  }

  /* ============ 菜单（按权限渲染，无权限的菜单不出现） ============ */
  var MENU = [
    { key: 'dashboard', name: '经营看板', icon: '📊', perm: 'stats:read' },
    { key: 'orders', name: '订单管理', icon: '🧾', perm: 'order:read' },
    { key: 'service', name: '客服消息', icon: '💬', perm: 'service:read' },
    { key: 'invoice', name: '发票管理', icon: '🧮', perm: 'invoice:read' },
    { key: 'voucher', name: '团购券核销', icon: '🎫', perm: 'voucher:verify' },
    { key: 'coupon', name: '优惠券', icon: '🎟️', perm: 'coupon:read' },
    { key: 'theme', name: '主题管理', icon: '🎨', perm: 'theme:read' },
    { key: 'dish', name: '菜单与库存', icon: '🍢', perm: 'dish:read' },
    { key: 'store', name: '门店管理', icon: '🏪', perm: 'store:read' },
    { key: 'staff', name: '员工与权限', icon: '👥', perm: 'staff:read' },
    { key: 'franchise', name: '加盟配置', icon: '🤝', perm: 'content:read' },
    { key: 'agreement', name: '协议及政策', icon: '📄', perm: 'content:read' },
    { key: 'audit', name: '审计日志', icon: '📜', perm: 'audit:read' },
  ];

  function shell(title, sub, bodyHtml) {
    var items = MENU.filter(function (m) { return has(m.perm); });
    el('root').innerHTML =
      '<div class="app">' +
      '<aside class="side">' +
      '<div class="logo">🌶️ <span>串串香 · 连锁后台</span></div>' +
      '<nav>' + items.map(function (m) {
        return '<a href="#" data-v="' + m.key + '" class="' + (S.view === m.key ? 'on' : '') + '">' + m.icon + ' <span>' + m.name + '</span></a>';
      }).join('') + '</nav>' +
      '<div class="me"><b>' + esc(S.staff.name || S.staff.account) + '</b>' + esc(S.staff.roleName) +
      '<div style="margin-top:6px"><a href="#" id="btnLogout" style="color:#ff8f8f;text-decoration:none;font-size:12px">退出登录</a></div></div>' +
      '</aside>' +
      '<main><header><h2>' + esc(title) + '</h2><div class="sub">' + (sub || '') + '</div>' +
      '<div class="right" id="headerRight"></div></header>' +
      '<div class="content" id="content">' + bodyHtml + '</div></main></div>';

    Array.prototype.forEach.call(document.querySelectorAll('nav a'), function (a) {
      a.onclick = function (e) { e.preventDefault(); S.view = a.dataset.v; render(); };
    });
    el('btnLogout').onclick = function (e) { e.preventDefault(); logout(); };
  }

  /* ============ 门店选择器（数据隔离的可见体现） ============ */
  function storeSelectorHtml(allowAll) {
    if (!S.stores.length) return '<span class="tag">无授权门店</span>';
    var opts = '';
    if (allowAll && S.staff.scope.allStores) opts += '<option value="">全部门店（品牌汇总）</option>';
    opts += S.stores.map(function (s) {
      return '<option value="' + s.id + '"' + (S.storeId === s.id ? ' selected' : '') + '>' + esc(s.name) + ' · ' + esc(s.typeText) + '</option>';
    }).join('');
    return '<select id="storeSel" style="width:auto;min-width:240px">' + opts + '</select>';
  }
  function bindStoreSelector(afterChange) {
    var sel = el('storeSel');
    if (!sel) return;
    sel.onchange = function () { S.storeId = sel.value; afterChange && afterChange(); };
  }

  /* ============ 视图：经营看板 ============ */
  function viewDashboard() {
    return api('/admin/summary').then(function (d) {
      var t = d.today;
      var body =
        '<div class="kpis">' +
        '<div class="kpi"><b>' + t.orderCount + '</b><span>今日订单</span></div>' +
        '<div class="kpi"><b>¥' + t.revenueText + '</b><span>今日营业额</span></div>' +
        '<div class="kpi"><b>' + t.pendingAcceptCount + '</b><span>待接单</span></div>' +
        '<div class="kpi"><b>' + t.voucherCount + '</b><span>今日团购券核销</span></div>' +
        '<div class="kpi"><b>¥' + t.voucherAmountText + '</b><span>核销券面值</span></div>' +
        '</div>' +
        '<div class="card"><h3>🔐 当前账号的数据权限<span class="sp">这是「数据隔离」的直接体现</span></h3>' +
        '<table><tbody>' +
        '<tr><th style="width:130px">角色</th><td>' + esc(d.scope.roleName) + ' <span class="tag tag-p">' + esc(d.scope.role) + '</span></td></tr>' +
        '<tr><th>可见门店</th><td>' + (d.scope.allStores ? '<span class="tag tag-ok">全部门店</span> ' : '') + d.scope.storeCount + ' 家：' + esc(d.scope.storeNames.join('、')) + '</td></tr>' +
        '<tr><th>区域</th><td>' + (esc(d.scope.region) || '<span class="tag">不限</span>') + '</td></tr>' +
        '<tr><th>权限点</th><td>' + (d.staff.perms.indexOf('*') > -1 ? '<span class="tag tag-ok">*（全部权限）</span>' : d.staff.perms.map(function (p) { return '<span class="tag" style="margin:2px">' + esc(p) + '</span>'; }).join('')) + '</td></tr>' +
        '</tbody></table></div>' +
        '<div class="card"><h3>🏪 门店经营概览</h3><div id="storeStats">加载中…</div></div>';
      shell('经营看板', '数据已按你的权限范围过滤', body);
      loadStoreStats();
    });
  }

  function loadStoreStats() {
    api('/admin/stats' + (S.storeId ? '?storeId=' + encodeURIComponent(S.storeId) : '')).then(function (d) {
      var box = el('storeStats');
      if (!box) return;
      var rows = (d.byStore || []).map(function (s) {
        return '<tr><td>' + esc(s.storeName) + '</td><td><span class="tag ' + (s.type === 'FRANCHISE' ? 'tag-a' : 'tag-info') + '">' + esc(s.typeText) + '</span></td>' +
          '<td>' + s.orderCount + '</td><td>¥' + s.revenueText + '</td><td>' + (s.orderCount ? '¥' + (s.revenue / s.orderCount / 100).toFixed(2) : '—') + '</td></tr>';
      }).join('');
      box.innerHTML =
        '<table><thead><tr><th>门店</th><th>类型</th><th>今日订单</th><th>营业额</th><th>客单价</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="5" class="empty">今日暂无订单</td></tr>') + '</tbody></table>' +
        '<div style="margin-top:12px" class="row">' + (d.byType || []).map(function (t) {
          return '<span class="tag ' + (t.type === 'FRANCHISE' ? 'tag-a' : 'tag-info') + '">' + esc(t.typeText) + '：' + t.orderCount + ' 单 / ¥' + t.revenueText + '</span>';
        }).join('') + '</div>';
    });
  }

  /* ============ 视图：订单 ============ */
  var ORDER_LABEL = { UNPAID: '待付款', PAID: '待接单', ACCEPTED: '制作中', COOKING: '涮煮中', READY: '可取餐', DONE: '已完成', CANCELED: '已取消' };
  var ORDER_FLOW = { PAID: [['accept', '接单'], ['reject', '拒单']], ACCEPTED: [['cook', '开始制作'], ['reject', '拒单']], COOKING: [['ready', '出餐']], READY: [['done', '完成']] };

  function viewOrders() {
    var q = '/admin/orders?status=all&size=50' + (S.storeId ? '&storeId=' + encodeURIComponent(S.storeId) : '');
    return api(q).then(function (d) {
      var rows = (d.list || []).map(function (o) {
        var acts = (ORDER_FLOW[o.status] || []).map(function (a) {
          return '<button class="btn btn-sm ' + (a[0] === 'reject' ? 'btn-d' : 'btn-p') + '" data-order="' + o.id + '" data-act="' + a[0] + '">' + a[1] + '</button>';
        }).join(' ');
        var items = (o.items || []).map(function (i) { return esc(i.name) + (i.spicyName ? '(' + esc(i.spicyName) + ')' : '') + '×' + i.count; }).join('、');
        return '<tr><td><b>' + esc(o.pickupNo) + '</b><div style="font-size:11px;color:#999">' + esc(o.orderNo.slice(-6)) + '</div></td>' +
          '<td>' + esc(o.storeName || '') + '</td>' +
          '<td>' + (o.diningType === 'takeout' ? '自取' : '堂食 ' + esc(o.tableNo)) + '</td>' +
          '<td style="max-width:260px">' + items + (o.urgeCount ? ' <span class="tag tag-a">催单' + o.urgeCount + '</span>' : '') + '</td>' +
          '<td>¥' + fen(o.amount.pay) + '</td>' +
          '<td><span class="tag ' + (o.status === 'READY' ? 'tag-ok' : o.status === 'DONE' || o.status === 'CANCELED' ? '' : 'tag-p') + '">' + (ORDER_LABEL[o.status] || o.status) + '</span></td>' +
          '<td>' + fmtTime(o.createTime) + '</td><td>' + (acts || '—') + '</td></tr>';
      }).join('');
      shell('订单管理', '共 ' + (d.total || 0) + ' 笔 · 仅显示你有权限的门店', 
        '<div class="card"><div class="storebar">' + storeSelectorHtml(true) +
        '<button class="btn" id="btnRefresh">刷新</button></div></div>' +
        '<div class="card"><div class="tbl-wrap"><table><thead><tr><th>取餐号</th><th>门店</th><th>就餐</th><th>明细</th><th>金额</th><th>状态</th><th>下单时间</th><th>操作</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="8" class="empty">今日暂无订单</td></tr>') + '</tbody></table></div></div>');
      bindStoreSelector(function () { render(); });
      el('btnRefresh').onclick = function () { render(); };
      bindOrderActs();
    });
  }

  function bindOrderActs() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-order]'), function (b) {
      b.onclick = function () {
        var id = b.dataset.order, act = b.dataset.act;
        if (act === 'reject') {
          modal('拒单', '<label class="f"><span>拒单原因</span><input type="text" id="rj" value="菜品售罄"></label>' +
            '<div style="font-size:12px;color:#b25a00">已支付订单拒单会自动退款给顾客</div>', function () {
            doOrderAct(id, act, el('rj').value);
          }, '确认拒单');
          return;
        }
        doOrderAct(id, act);
      };
    });
  }
  function doOrderAct(id, act, reason) {
    api('/admin/orders/' + id + '/' + act, { method: 'POST', body: reason ? { reason: reason } : {} })
      .then(function () { toast('操作成功'); render(); })
      .catch(function (e) { toast((e && e.message) || '操作失败'); });
  }

  /* ============ 视图：团购券核销 ============ */
  function viewVoucher() {
    if (!S.storeId && S.stores.length) S.storeId = S.stores[0].id;
    var q = '/admin/vouchers?size=30' + (S.storeId ? '&storeId=' + encodeURIComponent(S.storeId) : '');
    return api(q).then(function (d) {
      var rows = (d.list || []).map(function (v) {
        return '<tr><td><code>' + esc(v.code) + '</code></td><td>' + esc(v.productName) + '</td><td>¥' + v.faceValueText + '</td>' +
          '<td>' + esc(v.storeName || '') + '</td><td>' + (v.channel === 'SELF' ? '<span class="tag tag-info">顾客自助</span>' : '<span class="tag">店员核销</span>') + '</td>' +
          '<td>' + esc(v.verifiedAtText) + '</td><td><span class="tag ' + (v.status === 'VERIFIED' ? 'tag-ok' : '') + '">' + (v.status === 'VERIFIED' ? '已核销' : '已撤销') + '</span></td>' +
          '<td>' + (v.status === 'VERIFIED' && has('voucher:refund') ? '<button class="btn btn-sm btn-d" data-rv="' + v.id + '">撤销</button>' : '—') + '</td></tr>';
      }).join('');
      shell('团购券核销', '今日已核销 ' + (d.total || 0) + ' 张 · 面值合计 ¥' + fen(d.totalAmount || 0),
        '<div class="card"><h3>🎫 输入券码核销</h3>' +
        '<div class="grid3"><label class="f"><span>核销门店</span><div id="vStoreWrap">' + storeSelectorHtml(false) + '</div></label>' +
        '<label class="f"><span>券码</span><input type="text" id="vCode" placeholder="如 MT1688888888" autocomplete="off"></label>' +
        '<label class="f"><span>&nbsp;</span><button class="btn btn-p" id="btnVerify" style="width:100%;height:34px">核销</button></label></div>' +
        '<div id="vResult"></div>' +
        '<div style="font-size:12px;color:#8a8a8e;margin-top:8px">当前券商：<b>' + '配置见 VOUCHER_PROVIDER（mock/meituan）' + '</b> · 同一张券并发核销只会有一次成功（数据库唯一键兜底）</div>' +
        '</div>' +
        '<div class="card"><h3>核销记录</h3><div class="tbl-wrap"><table><thead><tr><th>券码</th><th>套餐</th><th>面值</th><th>门店</th><th>通道</th><th>核销时间</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="8" class="empty">暂无核销记录</td></tr>') + '</tbody></table></div></div>');
      bindStoreSelector(function () { S.storeId = el('storeSel').value; render(); });
      el('btnVerify').onclick = function () {
        var code = el('vCode').value.trim();
        if (!code) return toast('请输入券码');
        var sid = el('storeSel') ? el('storeSel').value : S.storeId;
        el('btnVerify').disabled = true;
        api('/admin/vouchers/verify', { method: 'POST', body: { code: code, storeId: sid } })
          .then(function (r) {
            el('btnVerify').disabled = false;
            el('vResult').innerHTML =
              '<div style="background:#e8f5e9;border:1px solid #b7e0bf;border-radius:8px;padding:12px;margin-top:6px">' +
              '<b style="color:#1b8a3e">✅ 核销成功</b><br>套餐：' + esc(r.productName) + '　面值：¥' + fen(r.faceValue) +
              '<br>门店：' + esc(r.storeName) + '　时间：' + esc(r.verifiedAtText) + '</div>';
            el('vCode').value = '';
          })
          .catch(function (e) {
            el('btnVerify').disabled = false;
            el('vResult').innerHTML = '<div style="background:#fdecec;border:1px solid #f5c2c2;border-radius:8px;padding:12px;margin-top:6px">' +
              '<b style="color:#c62828">❌ ' + esc((e && e.message) || '核销失败') + '</b></div>';
          });
      };
      el('vCode').onkeydown = function (e) { if (e.key === 'Enter') el('btnVerify').click(); };
      Array.prototype.forEach.call(document.querySelectorAll('[data-rv]'), function (b) {
        b.onclick = function () {
          modal('撤销核销', '<div style="color:#b25a00">撤销后会同步调用券商退款接口，并记录审计日志。确定继续？</div>', function () {
            api('/admin/vouchers/' + b.dataset.rv + '/refund', { method: 'POST' })
              .then(function () { toast('已撤销'); render(); })
              .catch(function (e) { toast((e && e.message) || '撤销失败'); });
          }, '确认撤销');
        };
      });
    });
  }

  /* ============ 视图：优惠券 ============ */
  function viewCoupon() {
    return Promise.all([api('/admin/coupons'), api('/admin/coupon-stats')]).then(function (res) {
      var list = res[0] || [], stats = res[1] || [];
      var statMap = new Map(stats.map(function (s) { return [s.id, s]; }));
      var rows = list.map(function (c) {
        var st = statMap.get(c.id) || {};
        return '<tr><td><b>' + esc(c.name) + '</b><div style="font-size:11px;color:#999">' + esc(c.id) + '</div></td>' +
          '<td>' + esc(c.type === 'CASH' ? '现金券' : c.type === 'SOUP' ? '锅底券' : '折扣券') + '</td>' +
          '<td>' + esc(c.valueText) + '</td><td>' + esc(c.thresholdText) + '</td>' +
          '<td>' + esc(c.storeScopeText) + '</td>' +
          '<td>' + (c.receiveEnabled ? '<span class="tag tag-ok">领券中心</span>' : '<span class="tag">定向发放</span>') + '</td>' +
          '<td>' + c.issued + ' / ' + c.total + '</td><td>' + (st.used || 0) + '</td><td>' + (st.usedRate || '0%') + '</td>' +
          '<td><span class="tag ' + (c.status ? 'tag-ok' : '') + '">' + (c.status ? '启用' : '停用') + '</span></td>' +
          '<td>' + (has('coupon:write') ? '<button class="btn btn-sm" data-cst="' + c.id + '" data-s="' + (c.status ? 0 : 1) + '">' + (c.status ? '停用' : '启用') + '</button> ' : '') +
          (has('coupon:issue') ? '<button class="btn btn-sm btn-a" data-cg="' + c.id + '">发放</button>' : '') + '</td></tr>';
      }).join('');
      shell('优惠券', '共 ' + list.length + ' 个券模板',
        '<div class="card">' +
        (has('coupon:write') ? '<button class="btn btn-p" id="btnNewCoupon">+ 新建券模板</button>' : '<span class="tag">只读权限</span>') +
        '</div>' +
        '<div class="card"><div class="tbl-wrap"><table><thead><tr><th>券名称</th><th>类型</th><th>面额</th><th>门槛</th><th>适用范围</th><th>发放方式</th><th>已发/总量</th><th>已核销</th><th>核销率</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="11" class="empty">暂无券模板</td></tr>') + '</tbody></table></div></div>');
      if (el('btnNewCoupon')) el('btnNewCoupon').onclick = couponForm;
      Array.prototype.forEach.call(document.querySelectorAll('[data-cst]'), function (b) {
        b.onclick = function () {
          api('/admin/coupons/' + b.dataset.cst + '/status', { method: 'POST', body: { status: Number(b.dataset.s) } })
            .then(function () { toast('已更新'); render(); }).catch(function (e) { toast((e && e.message) || '失败'); });
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-cg]'), function (b) {
        b.onclick = function () {
          var cid = b.dataset.cg;
          modal('定向发放优惠券', '<label class="f"><span>用户手机号（逗号分隔，最多 500 个）</span>' +
            '<textarea id="gphones" placeholder="13800000001,13800000002"></textarea></label>' +
            '<div style="font-size:12px;color:#8a8a8e">也可填 openid，用英文逗号分隔</div>', function () {
            var phones = (el('gphones').value || '').split(/[,，\s]+/).filter(Boolean);
            if (!phones.length) { toast('请输入至少一个手机号'); return false; }
            api('/admin/coupons/' + cid + '/grant', { method: 'POST', body: { phones: phones } })
              .then(function (r) { toast('成功发放 ' + r.success + ' / ' + r.total); render(); })
              .catch(function (e) { toast((e && e.message) || '发放失败'); });
          }, '确认发放');
        };
      });
    });
  }

  function couponForm() {
    modal('新建券模板',
      '<div class="grid2">' +
      '<label class="f"><span>券名称</span><input type="text" id="cName" placeholder="如 满 50 减 10"></label>' +
      '<label class="f"><span>券类型</span><select id="cType"><option value="CASH">现金券</option><option value="SOUP">锅底券</option><option value="DISCOUNT">折扣券</option></select></label>' +
      '</div><div class="grid3">' +
      '<label class="f"><span>面额（分，折扣券填 88=8.8折）</span><input type="number" id="cValue" value="1000"></label>' +
      '<label class="f"><span>门槛（分，0=无门槛）</span><input type="number" id="cThreshold" value="5000"></label>' +
      '<label class="f"><span>总量</span><input type="number" id="cTotal" value="1000"></label>' +
      '</div><div class="grid2">' +
      '<label class="f"><span>每人限领</span><input type="number" id="cPer" value="1"></label>' +
      '<label class="f"><span>每人每日限领（0=不限）</span><input type="number" id="cDay" value="1"></label>' +
      '</div><label class="f"><span>适用门店</span><select id="cStore"><option value="">全品牌通用</option>' +
      S.stores.map(function (s) { return '<option value="' + s.id + '">仅 ' + esc(s.name) + '</option>'; }).join('') +
      '</select></label>' +
      '<div class="grid2"><label class="f"><span>发放方式</span><select id="cIssue"><option value="RECEIVE">领券中心自取</option><option value="NEW_USER">新客自动发</option><option value="MANUAL">仅定向发放</option></select></label>' +
      '<label class="f"><span>有效期至</span><input type="text" id="cExpire" value="2026-12-31"></label></div>',
      function () {
        var body = {
          name: el('cName').value.trim(),
          type: el('cType').value,
          value: Number(el('cValue').value),
          threshold: Number(el('cThreshold').value),
          total: Number(el('cTotal').value),
          perUser: Number(el('cPer').value),
          dayLimit: Number(el('cDay').value),
          storeIds: el('cStore').value ? [el('cStore').value] : [],
          issueType: el('cIssue').value,
          receiveEnabled: el('cIssue').value === 'RECEIVE',
          expireAt: el('cExpire').value,
        };
        api('/admin/coupons', { method: 'POST', body: body })
          .then(function () { toast('已创建'); render(); })
          .catch(function (e) { toast((e && e.message) || '创建失败'); });
      }, '创建');
  }

  /* ============ 视图：主题管理 ============ */
  function viewTheme() {
    var sid = S.storeId || (S.stores[0] ? S.stores[0].id : '');
    return api('/admin/themes?storeId=' + encodeURIComponent(sid)).then(function (d) {
      var cur = d.current || { tokens: d.defaultTokens };
      var preview =
        '<div class="theme-preview" style="background:linear-gradient(150deg,' + esc(cur.tokens.navBg) + ',' + esc(cur.tokens.primaryDark) + ')">' +
        (cur.tokens.badge ? '<div class="badge">' + esc(cur.tokens.badge) + '</div>' : '') +
        '<b>' + esc(cur.tokens.bannerText || '老北京麻辣串串香') + '</b>' +
        '<small>' + esc(cur.tokens.bannerSub || '现串现涮 · 每日 11:00 开锅') + '</small>' +
        '<div class="swatches">' + ['primary', 'primaryDark', 'primaryWeak', 'accent', 'barBg'].map(function (k) {
          return '<i style="background:' + esc(cur.tokens[k]) + '" title="' + k + '"></i>';
        }).join('') + '</div></div>';

      var rows = (d.list || []).map(function (t) {
        var stateTag = { ACTIVE: '<span class="tag tag-ok">生效中</span>', PENDING: '<span class="tag tag-info">待生效</span>', EXPIRED: '<span class="tag">已过期</span>', DISABLED: '<span class="tag">已停用</span>' }[t.state];
        var isCur = t.id === cur.id;
        return '<tr><td><b>' + esc(t.name) + '</b>' + (isCur ? ' <span class="tag tag-p">当前生效</span>' : '') + '</td>' +
          '<td>' + esc({ NORMAL: '标准', CAMPAIGN: '活动日', HOLIDAY: '节假日', MEMBER_DAY: '会员日', CUSTOM: '自定义' }[t.type] || t.type) + '</td>' +
          '<td>' + (t.scope === 'STORE' ? '<span class="tag tag-a">门店级</span>' : '<span class="tag tag-info">品牌级</span>') + '<div style="font-size:11px;color:#999">' + esc(t.storeId || '全品牌') + '</div></td>' +
          '<td>优先级 ' + t.priority + '</td>' +
          '<td style="font-size:12px">' + (t.startAt ? fmtTime(t.startAt).slice(0, 10) + ' ~ ' + fmtTime(t.endAt).slice(0, 10) : '长期') + '</td>' +
          '<td>' + stateTag + '</td>' +
          '<td><i style="display:inline-block;width:14px;height:14px;border-radius:4px;background:' + esc(t.tokens.primary) + ';vertical-align:-2px"></i> ' + esc(t.tokens.primary) + '</td>' +
          '<td>' + (has('theme:write')
            ? '<button class="btn btn-sm btn-p" data-tact="' + t.id + '">立即启用</button> ' +
              '<button class="btn btn-sm" data-ttog="' + t.id + '" data-s="' + (t.status ? 0 : 1) + '">' + (t.status ? '停用' : '启用') + '</button> ' +
              '<button class="btn btn-sm btn-d" data-tdel="' + t.id + '">删除</button>'
            : '—') + '</td></tr>';
      }).join('');

      shell('主题管理', '门店级主题优先于品牌级；同级取优先级最高且在生效时间窗内的',
        '<div class="card"><h3>🎨 当前生效主题（' + esc(sid) + '）<span class="sp">' + esc(cur.name) + ' · ' + esc(cur.scope === 'STORE' ? '门店级' : cur.scope === 'BRAND' ? '品牌级' : '默认') + '</span></h3>' +
        '<div class="grid2"><div>' + preview + '</div>' +
        '<div class="row" style="align-items:flex-start">' + storeSelectorHtml(false) + '</div></div></div>' +
        '<div class="card"><h3>一键套用预置主题<span class="sp">运营不需要自己配颜色</span></h3><div class="row" id="presets">' +
        (d.presets || []).map(function (p) {
          return '<button class="btn" data-tpreset="' + p.key + '">' + esc(p.name) + '<div style="font-size:11px;color:#999">' + esc(p.description) + '</div></button>';
        }).join('') + '</div></div>' +
        '<div class="card"><h3>全部主题</h3><div class="tbl-wrap"><table><thead><tr><th>名称</th><th>类型</th><th>层级</th><th>优先级</th><th>生效时间</th><th>状态</th><th>主色</th><th>操作</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="8" class="empty">暂无主题</td></tr>') + '</tbody></table></div></div>');

      bindStoreSelector(function () { S.storeId = el('storeSel').value; render(); });
      Array.prototype.forEach.call(document.querySelectorAll('[data-tact]'), function (b) {
        b.onclick = function () {
          api('/admin/themes/' + b.dataset.tact + '/activate', { method: 'POST' })
            .then(function () { toast('已切换，小程序端下次进入立即生效'); render(); })
            .catch(function (e) { toast((e && e.message) || '失败'); });
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-ttog]'), function (b) {
        b.onclick = function () {
          api('/admin/themes/' + b.dataset.ttog + '/status', { method: 'POST', body: { status: Number(b.dataset.s) } })
            .then(function () { toast('已更新'); render(); }).catch(function (e) { toast((e && e.message) || '失败'); });
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-tdel]'), function (b) {
        b.onclick = function () {
          modal('删除主题', '<div style="color:#b25a00">删除后不可恢复，确定？</div>', function () {
            api('/admin/themes/' + b.dataset.tdel, { method: 'DELETE' })
              .then(function () { toast('已删除'); render(); }).catch(function (e) { toast((e && e.message) || '失败'); });
          }, '删除');
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-tpreset]'), function (b) {
        b.onclick = function () { applyPreset(b.dataset.tpreset, sid, d); };
      });
    });
  }

  function applyPreset(key, storeId, d) {
    var preset = (d.presets || []).filter(function (p) { return p.key === key; })[0];
    if (!preset) return;
    modal('套用「' + preset.name + '」',
      '<div class="grid2"><label class="f"><span>主题名称</span><input type="text" id="tName" value="' + esc(preset.name) + '"></label>' +
      '<label class="f"><span>优先级（越大越优先）</span><input type="number" id="tPri" value="100"></label></div>' +
      '<div class="grid2"><label class="f"><span>开始时间（可空=长期）</span><input type="text" id="tStart" placeholder="2026-10-01 00:00"></label>' +
      '<label class="f"><span>结束时间</span><input type="text" id="tEnd" placeholder="2026-10-08 23:59"></label></div>' +
      '<label class="f"><span>作用范围</span><select id="tScope"><option value="' + esc(storeId) + '">门店：' + esc(storeId) + '</option><option value="">品牌级（全部门店）</option></select></label>' +
      '<div style="font-size:12px;color:#8a8a8e">令牌（可直接改）：</div>' +
      Object.keys(d.defaultTokens).map(function (k) {
        var v = preset.tokens[k] !== undefined ? preset.tokens[k] : d.defaultTokens[k];
        return '<label class="f" style="margin:6px 0"><span>' + k + '</span><input type="text" id="tk_' + k + '" value="' + esc(v) + '"></label>';
      }).join(''),
      function () {
        var tokens = {};
        Object.keys(d.defaultTokens).forEach(function (k) {
          var i = el('tk_' + k);
          if (i) tokens[k] = i.value;
        });
        var toTs = function (s) { return s ? new Date(s.replace(' ', 'T')).getTime() : 0; };
        api('/admin/themes', { method: 'POST', body: {
          name: el('tName').value, type: preset.type, storeId: el('tScope').value,
          tokens: tokens, priority: Number(el('tPri').value),
          startAt: toTs(el('tStart').value), endAt: toTs(el('tEnd').value),
          description: preset.description,
        } }).then(function (r) {
          return api('/admin/themes/' + r.id + '/activate', { method: 'POST' });
        }).then(function () { toast('主题已创建并启用'); render(); })
          .catch(function (e) { toast((e && e.message) || '创建失败'); });
      }, '创建并启用');
  }

  /* ============ 视图：菜单与库存 ============ */
  function viewDish() {
    if (!S.storeId && S.stores.length) S.storeId = S.stores[0].id;
    return api('/admin/dishes?storeId=' + encodeURIComponent(S.storeId)).then(function (d) {
      var rows = (d.list || []).map(function (x) {
        return '<tr><td>' + x.emoji + ' <b>' + esc(x.name) + '</b></td><td>' + esc(x.categoryName || '') + '</td>' +
          '<td>¥' + x.priceText + '</td>' +
          '<td>¥' + fen(x.effectivePrice) + (x.priceOverride ? ' <span class="tag tag-a">门店改价</span>' : '') + '</td>' +
          '<td>' + (has('dish:stock') ? '<input type="number" style="width:80px" value="' + x.storeStock + '" data-dstock="' + x.id + '">' : x.storeStock) + '</td>' +
          '<td>' + x.storeSold + '</td>' +
          '<td><span class="tag ' + (x.storeStatus ? 'tag-ok' : '') + '">' + (x.storeStatus ? '本店在售' : '本店停售') + '</span> ' +
          '<span class="tag ' + (x.status ? '' : 'tag-a') + '">' + (x.status ? '总部上架' : '总部下架') + '</span></td>' +
          '<td>' + (has('dish:stock') ? '<button class="btn btn-sm" data-dtoggle="' + x.id + '" data-s="' + (x.storeStatus ? 0 : 1) + '">' + (x.storeStatus ? '本店停售' : '本店开卖') + '</button>' : '—') + '</td></tr>';
      }).join('');
      shell('菜单与库存', '总部维护菜单与指导价，门店维护库存与上下架',
        '<div class="card"><div class="storebar">' + storeSelectorHtml(false) +
        '<button class="btn btn-p" id="btnSaveStock">保存库存</button>' +
        '<span class="tag">门店改价上限 = 指导价的 2 倍</span></div></div>' +
        '<div class="card"><div class="tbl-wrap"><table><thead><tr><th>菜品</th><th>分类</th><th>指导价</th><th>本店售价</th><th>本店库存</th><th>已售</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="8" class="empty">暂无菜品</td></tr>') + '</tbody></table></div></div>');
      bindStoreSelector(function () { S.storeId = el('storeSel').value; render(); });
      el('btnSaveStock').onclick = function () {
        var items = [];
        Array.prototype.forEach.call(document.querySelectorAll('[data-dstock]'), function (i) {
          items.push({ dishId: i.dataset.dstock, stock: Number(i.value) });
        });
        if (!items.length) return toast('没有可保存的库存');
        api('/admin/store-dishes', { method: 'POST', body: { storeId: S.storeId, items: items } })
          .then(function (r) { toast('已保存 ' + r.updated + ' 项'); render(); })
          .catch(function (e) { toast((e && e.message) || '保存失败'); });
      };
      Array.prototype.forEach.call(document.querySelectorAll('[data-dtoggle]'), function (b) {
        b.onclick = function () {
          api('/admin/dishes/' + b.dataset.dtoggle + '/status', { method: 'POST', body: { storeId: S.storeId, status: Number(b.dataset.s) } })
            .then(function () { toast('已更新'); render(); }).catch(function (e) { toast((e && e.message) || '失败'); });
        };
      });
    });
  }

  /* ============ 视图：门店管理 ============ */
  function viewStore() {
    return api('/admin/stores').then(function (d) {
      var rows = (d.list || []).map(function (s) {
        return '<tr><td><b>' + esc(s.name) + '</b><div style="font-size:11px;color:#999">' + esc(s.code) + '</div></td>' +
          '<td><span class="tag ' + (s.type === 'FRANCHISE' ? 'tag-a' : 'tag-info') + '">' + esc(s.typeText) + '</span></td>' +
          '<td>' + esc(s.franchisee || '—') + '</td><td>' + esc(s.region) + '</td>' +
          '<td>' + esc(s.address) + '<div style="font-size:11px;color:#999">' + s.latitude + ',' + s.longitude + '</div></td>' +
          '<td>' + esc(s.phone) + '</td>' +
          '<td>' + s.todayOrderCount + ' 单<div style="font-size:11px;color:#999">¥' + s.todayRevenueText + '</div></td>' +
          '<td><span class="tag ' + (s.status ? 'tag-ok' : '') + '">' + (s.status ? '营业中' : '停业') + '</span></td>' +
          '<td>' + (has('store:write') ? '<button class="btn btn-sm" data-sedit="' + s.id + '">编辑</button> ' +
            '<button class="btn btn-sm ' + (s.status ? 'btn-d' : 'btn-p') + '" data-stog="' + s.id + '" data-s="' + (s.status ? 0 : 1) + '">' + (s.status ? '停业' : '开业') + '</button>' : '—') + '</td></tr>';
      }).join('');
      shell('门店管理', '共 ' + d.total + ' 家（直营 / 加盟）',
        '<div class="card">' + (has('store:write') ? '<button class="btn btn-p" id="btnNewStore">+ 新增门店</button>' : '<span class="tag">只读权限</span>') +
        '<div style="font-size:12px;color:#8a8a8e;margin-top:8px">新增门店会自动继承品牌菜单（库存从 0 开始，由门店自己开卖）；经纬度用于小程序的「就近门店」排序。</div></div>' +
        '<div class="card"><div class="tbl-wrap"><table><thead><tr><th>门店</th><th>类型</th><th>加盟商</th><th>大区</th><th>地址 / 经纬度</th><th>电话</th><th>今日经营</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="9" class="empty">暂无门店</td></tr>') + '</tbody></table></div></div>');
      if (el('btnNewStore')) el('btnNewStore').onclick = function () { storeForm(null, d.list); };
      Array.prototype.forEach.call(document.querySelectorAll('[data-sedit]'), function (b) {
        b.onclick = function () { storeForm(d.list.filter(function (s) { return s.id === b.dataset.sedit; })[0], d.list); };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-stog]'), function (b) {
        b.onclick = function () {
          api('/admin/stores/' + b.dataset.stog + '/status', { method: 'POST', body: { status: Number(b.dataset.s) } })
            .then(function () { toast('已更新'); render(); }).catch(function (e) { toast((e && e.message) || '失败'); });
        };
      });
    });
  }

  function storeForm(s, list) {
    s = s || {};
    modal(s.id ? '编辑门店' : '新增门店',
      '<div class="grid2"><label class="f"><span>门店名称</span><input type="text" id="sName" value="' + esc(s.name || '') + '"></label>' +
      '<label class="f"><span>门店编码</span><input type="text" id="sCode" value="' + esc(s.code || '') + '"></label></div>' +
      '<div class="grid2"><label class="f"><span>门店类型</span><select id="sType">' +
      '<option value="DIRECT"' + (s.type === 'DIRECT' ? ' selected' : '') + '>直营店</option>' +
      '<option value="FRANCHISE"' + (s.type === 'FRANCHISE' ? ' selected' : '') + '>加盟店</option></select></label>' +
      '<label class="f"><span>加盟商主体（加盟店必填）</span><input type="text" id="sFran" value="' + esc(s.franchisee || '') + '"></label></div>' +
      '<div class="grid2"><label class="f"><span>所属大区</span><input type="text" id="sRegion" value="' + esc(s.region || '华北') + '"></label>' +
      '<label class="f"><span>城市</span><input type="text" id="sCity" value="' + esc(s.city || '北京') + '"></label></div>' +
      '<label class="f"><span>详细地址</span><input type="text" id="sAddr" value="' + esc(s.address || '') + '"></label>' +
      '<div class="grid3"><label class="f"><span>纬度</span><input type="text" id="sLat" value="' + (s.latitude || '39.9') + '"></label>' +
      '<label class="f"><span>经度</span><input type="text" id="sLng" value="' + (s.longitude || '116.4') + '"></label>' +
      '<label class="f"><span>人均（元）</span><input type="number" id="sPer" value="' + (s.perCapita || 65) + '"></label></div>',
      function () {
        var body = {
          id: s.id || undefined,
          name: el('sName').value.trim(), code: el('sCode').value.trim(), type: el('sType').value,
          franchisee: el('sFran').value.trim(), region: el('sRegion').value.trim(), city: el('sCity').value.trim(),
          address: el('sAddr').value.trim(), latitude: Number(el('sLat').value), longitude: Number(el('sLng').value),
          perCapita: Number(el('sPer').value) * 100,
        };
        if (!body.name) { toast('请填写门店名称'); return false; }
        api('/admin/stores', { method: 'POST', body: body })
          .then(function () { toast(s.id ? '已保存' : '已创建'); loadStores().then(render); })
          .catch(function (e) { toast((e && e.message) || '保存失败'); });
      }, '保存');
  }

  /* ============ 视图：员工与权限 ============ */
  function viewStaff() {
    return api('/admin/staff').then(function (d) {
      var rows = (d.list || []).map(function (s) {
        return '<tr><td><b>' + esc(s.name) + '</b><div style="font-size:11px;color:#999">' + esc(s.account) + '</div></td>' +
          '<td><span class="tag ' + (s.role === 'BRAND_ADMIN' ? 'tag-p' : s.role === 'REGION_MANAGER' ? 'tag-info' : s.role === 'FRANCHISE_OWNER' ? 'tag-a' : '') + '">' + esc(s.roleName) + '</span></td>' +
          '<td style="max-width:240px">' + esc(s.storeNames.join('、')) + '</td>' +
          '<td>' + (s.region ? esc(s.region) : '—') + '</td>' +
          '<td><span class="tag ' + (s.status ? 'tag-ok' : '') + '">' + (s.status ? '启用' : '停用') + '</span>' + (s.mustChangePwd ? ' <span class="tag tag-a">待改密</span>' : '') + (s.locked ? ' <span class="tag tag-d">已锁定</span>' : '') + '</td>' +
          '<td style="font-size:12px">' + (s.lastLoginAt ? fmtTime(s.lastLoginAt) : '从未登录') + '</td>' +
          '<td>' + (has('staff:write') ? '<button class="btn btn-sm" data-edit="' + s.id + '">编辑</button> ' +
            '<button class="btn btn-sm btn-a" data-rst="' + s.id + '">重置密码</button> ' +
            '<button class="btn btn-sm ' + (s.status ? 'btn-d' : 'btn-p') + '" data-tog="' + s.id + '" data-s="' + (s.status ? 0 : 1) + '">' + (s.status ? '停用' : '启用') + '</button>' : '—') + '</td></tr>';
      }).join('');
      var roleDesc = (d.roles || []).map(function (r) { return '<span class="tag" style="margin:2px">' + esc(r.name) + '</span>'; }).join('');
      shell('员工与权限', '共 ' + d.total + ' 个账号 · 只能管理你权限范围内的账号',
        '<div class="card"><h3>角色说明</h3><div>' + roleDesc + '</div>' +
        '<div style="font-size:12px;color:#8a8a8e;margin-top:8px">品牌超管=全部门店全部权限；区域经理=本大区门店；店长/店员=被授权门店；加盟商=仅自己的加盟店。</div>' +
        (has('staff:write') ? '<div style="margin-top:12px"><button class="btn btn-p" id="btnNewStaff">+ 新增员工</button></div>' : '') + '</div>' +
        '<div class="card"><div class="tbl-wrap"><table><thead><tr><th>姓名 / 账号</th><th>角色</th><th>授权门店</th><th>大区</th><th>状态</th><th>最后登录</th><th>操作</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="7" class="empty">暂无员工</td></tr>') + '</tbody></table></div></div>');
      if (el('btnNewStaff')) el('btnNewStaff').onclick = function () { staffForm(null, d); };
      Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function (b) {
        b.onclick = function () { staffForm(d.list.filter(function (s) { return String(s.id) === b.dataset.edit; })[0], d); };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-rst]'), function (b) {
        b.onclick = function () {
          modal('重置密码', '<div style="color:#b25a00">重置后该员工首次登录必须修改密码。留空则自动生成。</div>' +
            '<label class="f"><span>新密码</span><input type="text" id="npw" placeholder="留空自动生成 Lbz@XXXXXX"></label>', function () {
            api('/admin/staff/' + b.dataset.rst + '/reset-password', { method: 'POST', body: { password: el('npw').value || undefined } })
              .then(function (r) { modal('重置成功', '<div>新密码：<b>' + esc(r.newPassword) + '</b><br><span style="color:#b25a00">请立即告知员工，该密码只显示这一次</span></div>'); render(); })
              .catch(function (e) { toast((e && e.message) || '失败'); });
          }, '确认重置');
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-tog]'), function (b) {
        b.onclick = function () {
          api('/admin/staff/' + b.dataset.tog + '/status', { method: 'POST', body: { status: Number(b.dataset.s) } })
            .then(function () { toast('已更新'); render(); }).catch(function (e) { toast((e && e.message) || '失败'); });
        };
      });
    });
  }

  function staffForm(s, d) {
    s = s || {};
    var roles = d.roles || [];
    var myScopeIds = S.staff.scope.allStores ? null : (S.staff.scope.storeIds || []);
    var selectable = myScopeIds ? S.stores.filter(function (st) { return myScopeIds.indexOf(st.id) > -1; }) : S.stores;
    modal(s.id ? '编辑员工' : '新增员工',
      '<div class="grid2"><label class="f"><span>登录账号（小写字母/数字）</span><input type="text" id="stAcc" value="' + esc(s.account || '') + '"' + (s.id ? ' disabled' : '') + '></label>' +
      '<label class="f"><span>姓名</span><input type="text" id="stName" value="' + esc(s.name || '') + '"></label></div>' +
      '<div class="grid2"><label class="f"><span>角色</span><select id="stRole">' +
      roles.filter(function (r) { return S.staff.scope.role === 'BRAND_ADMIN' || r.key !== 'BRAND_ADMIN'; }).map(function (r) {
        return '<option value="' + r.key + '"' + (s.role === r.key ? ' selected' : '') + '>' + esc(r.name) + '</option>';
      }).join('') + '</select></label>' +
      '<label class="f"><span>大区（区域经理填）</span><input type="text" id="stRegion" value="' + esc(s.region || '') + '"></label></div>' +
      '<label class="f"><span>授权门店（多选，按住 Ctrl/Cmd）</span><select id="stStores" multiple size="6">' +
      selectable.map(function (st) {
        var sel = (s.storeIds || []).indexOf(st.id) > -1 ? ' selected' : '';
        return '<option value="' + st.id + '"' + sel + '>' + esc(st.name) + ' · ' + esc(st.typeText) + '</option>';
      }).join('') + '</select></label>' +
      (s.id ? '' : '<label class="f"><span>初始密码（留空自动生成，首登强制改密）</span><input type="text" id="stPwd" placeholder="Lbz@XXXXXX"></label>') +
      '<div style="font-size:12px;color:#8a8a8e">只能授权你有权管理的门店 —— 这是防止「自己给自己扩权」的关键约束。</div>',
      function () {
        var sel = el('stStores');
        var ids = Array.prototype.filter.call(sel.options, function (o) { return o.selected; }).map(function (o) { return o.value; });
        var body = {
          id: s.id || undefined,
          account: el('stAcc').value.trim(),
          name: el('stName').value.trim(),
          role: el('stRole').value,
          region: el('stRegion').value.trim(),
          storeIds: ids,
          password: el('stPwd') ? el('stPwd').value.trim() : undefined,
        };
        if (!body.name) { toast('请填写姓名'); return false; }
        api('/admin/staff', { method: 'POST', body: body })
          .then(function (r) {
            if (r.initialPassword) {
              modal('创建成功', '<div>账号：<b>' + esc(r.account) + '</b><br>初始密码：<b>' + esc(r.initialPassword) + '</b><br><span style="color:#b25a00">只显示这一次，请立即转交</span></div>');
            } else toast('已保存');
            render();
          })
          .catch(function (e) { toast((e && e.message) || '保存失败'); });
      }, '保存');
  }

  /* ============ 视图：审计日志 ============ */
  function viewAudit() {
    return Promise.all([api('/admin/audit?size=50'), api('/admin/login-logs?size=30')]).then(function (r) {
      var audit = r[0], login = r[1];
      var aRows = (audit.list || []).map(function (a) {
        return '<tr><td>' + esc(a.createdAtText) + '</td><td>' + esc(a.staffName) + '<div style="font-size:11px;color:#999">' + esc(a.role) + '</div></td>' +
          '<td><span class="tag tag-p">' + esc(a.action) + '</span></td><td>' + esc(a.target) + '</td>' +
          '<td style="max-width:280px;font-size:12px">' + esc(a.detail) + '</td><td>' + esc(a.ip) + '</td></tr>';
      }).join('');
      var lRows = (login.list || []).map(function (l) {
        return '<tr><td>' + esc(l.createdAtText) + '</td><td>' + esc(l.account) + '</td>' +
          '<td>' + (l.success ? '<span class="tag tag-ok">成功</span>' : '<span class="tag tag-d">失败</span>') + '</td>' +
          '<td>' + esc(l.reason) + '</td><td>' + esc(l.ip) + '</td></tr>';
      }).join('');
      shell('审计日志', '管理端所有写操作与登录行为都留痕',
        '<div class="card"><h3>操作审计<span class="sp">共 ' + audit.total + ' 条</span></h3><div class="tbl-wrap"><table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th><th>IP</th></tr></thead><tbody>' +
        (aRows || '<tr><td colspan="6" class="empty">暂无记录</td></tr>') + '</tbody></table></div></div>' +
        '<div class="card"><h3>登录日志<span class="sp">共 ' + login.total + ' 条（含失败，用于排查暴力破解）</span></h3><div class="tbl-wrap"><table><thead><tr><th>时间</th><th>账号</th><th>结果</th><th>原因</th><th>IP</th></tr></thead><tbody>' +
        (lRows || '<tr><td colspan="5" class="empty">暂无记录</td></tr>') + '</tbody></table></div></div>');
    });
  }

  /* ============ 路由 ============ */
  /* ============ 视图：客服消息（用户端「我的 → 在线客服」的回复端） ============ */
  var SVC_MSG_LABEL = { image: '[图片]', video: '[视频]', voice: '[语音]', file: '[文件]' };

  function svcPreview(t) {
    return esc((t.lastPreview || '').slice(0, 22)) || '（暂无消息）';
  }

  function viewService() {
    var status = S.svcStatus || 'OPEN';
    return api('/admin/service/tickets?status=' + status + '&size=60').then(function (d) {
      S.svcTickets = d.list || [];
      var items = S.svcTickets.map(function (t) {
        return '<div class="svc__item" data-tid="' + t.id + '">' +
          '<div class="svc__item-head"><b>' + esc(t.nickname) + '</b>' +
          (t.adminUnread ? '<span class="tag tag-p">未读 ' + t.adminUnread + '</span>' : '') + '</div>' +
          '<div class="svc__item-sub">' + svcPreview(t) + '</div>' +
          '<div class="svc__item-time">' + fmtTime(t.lastMsgAt) + (t.storeId ? ' · ' + esc(t.storeId) : '') + '</div>' +
          '</div>';
      }).join('');
      shell('客服消息', '用户在「我的 → 在线客服」发来的消息 · 仅显示你权限内的门店',
        '<div class="svc">' +
        '<div class="card svc__list">' +
        '<h3>会话<span class="sp">' + S.svcTickets.length + ' 条</span></h3>' +
        '<div class="row" style="margin-bottom:10px">' +
        '<button class="btn btn-sm ' + (status === 'OPEN' ? 'btn-p' : '') + '" data-sst="OPEN">进行中</button>' +
        '<button class="btn btn-sm ' + (status === 'CLOSED' ? 'btn-p' : '') + '" data-sst="CLOSED">已结束</button>' +
        '</div>' +
        '<div class="svc__items">' + (items || '<div class="empty">暂无会话</div>') + '</div>' +
        '</div>' +
        '<div class="card svc__chat" id="svcChat"><div class="empty">← 选择左侧会话开始回复</div></div>' +
        '</div>');

      Array.prototype.forEach.call(document.querySelectorAll('[data-sst]'), function (b) {
        b.onclick = function () { S.svcStatus = b.dataset.sst; S.svcOpen = null; render(); };
      });
      Array.prototype.forEach.call(document.querySelectorAll('.svc__item'), function (n) {
        n.onclick = function () { openTicket(Number(n.dataset.tid)); };
      });
      if (S.svcOpen) openTicket(S.svcOpen, true);
    });
  }

  function openTicket(id, silent) {
    S.svcOpen = id;
    var box = el('svcChat');
    if (!silent || !box) return;
    return api('/admin/service/tickets/' + id).then(function (d) {
      S.svcDetail = d;
      renderTicket();
      /* 打开会话后自动轮询，客服不用手动刷新就能看到新消息 */
      if (S.svcTimer) clearInterval(S.svcTimer);
      S.svcTimer = setInterval(function () {
        if (S.view !== 'service' || !document.getElementById('svcChat')) { clearInterval(S.svcTimer); S.svcTimer = null; return; }
        api('/admin/service/tickets/' + id).then(function (dd) { S.svcDetail = dd; renderTicket(); }).catch(function () {});
      }, 6000);
    });
  }

  function renderTicket() {
    var d = S.svcDetail;
    var box = el('svcChat');
    if (!box || !d) return;
    var msgs = (d.list || []).map(function (m) {
      var body;
      if (m.type === 'text') body = esc(m.content).replace(/\n/g, '<br/>');
      else body = '<a href="' + esc(m.mediaUrl) + '" target="_blank" rel="noopener">' + (SVC_MSG_LABEL[m.type] || '[附件]') +
        (m.meta && m.meta.name ? ' ' + esc(m.meta.name) : '') + (m.meta && m.meta.duration ? ' ' + m.meta.duration + '″' : '') + '</a>';
      return '<div class="msg msg--' + m.sender.toLowerCase() + '">' +
        '<div class="msg__meta">' + (m.sender === 'USER' ? esc(d.ticket.nickname) : m.sender === 'ADMIN' ? '客服' : '系统') + ' · ' + fmtTime(m.createdAt) + '</div>' +
        '<div class="msg__bubble">' + body + '</div></div>';
    }).join('');
    box.innerHTML =
      '<div class="svc__chat-head"><b>' + esc(d.ticket.nickname) + '</b>' +
      '<span class="tag ' + (d.ticket.status === 'OPEN' ? 'tag-ok' : '') + '">' + (d.ticket.status === 'OPEN' ? '进行中' : '已结束') + '</span>' +
      (d.ticket.phoneMask ? '<span class="tag">' + esc(d.ticket.phoneMask) + '</span>' : '') +
      '<span class="sp" style="margin-left:auto">' +
      '<button class="btn btn-sm" id="svcRefresh">刷新</button> ' +
      (d.ticket.status === 'OPEN' && has('service:reply') ? '<button class="btn btn-sm btn-d" id="svcClose">结束会话</button>' : '') +
      '</span></div>' +
      '<div class="svc__msgs" id="svcMsgs">' + (msgs || '<div class="empty">暂无消息</div>') + '</div>' +
      (d.ticket.status === 'OPEN' && has('service:reply')
        ? '<div class="svc__reply"><textarea id="svcInput" placeholder="输入回复内容，Enter 换行，点击发送（Ctrl/Cmd + Enter 快捷发送）"></textarea>' +
          '<button class="btn btn-p" id="svcSend">发送</button></div>'
        : '<div class="empty" style="padding:16px 0">会话已结束，如需继续请联系用户重新发起</div>');
    var msgsBox = el('svcMsgs');
    if (msgsBox) msgsBox.scrollTop = msgsBox.scrollHeight;
    var rf = el('svcRefresh');
    if (rf) rf.onclick = function () { openTicket(d.ticket.id, true); };
    var cl = el('svcClose');
    if (cl) cl.onclick = function () {
      if (!window.confirm('结束后用户需要重新发起会话，确定结束？')) return;
      api('/admin/service/tickets/' + d.ticket.id + '/close', { method: 'POST' }).then(function () { toast('已结束会话'); viewService(); });
    };
    var sd = el('svcSend');
    if (sd) {
      sd.onclick = function () { sendReply(d.ticket.id); };
      el('svcInput').onkeydown = function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendReply(d.ticket.id);
      };
    }
  }

  function sendReply(ticketId) {
    var input = el('svcInput');
    var content = (input.value || '').trim();
    if (!content) return toast('请输入回复内容');
    api('/admin/service/tickets/' + ticketId + '/reply', { method: 'POST', body: { content: content } })
      .then(function () {
        input.value = '';
        toast('已发送');
        return openTicket(ticketId, true);
      })
      .catch(function (e) { toast((e && e.message) || '发送失败'); });
  }

  /* ============ 视图：发票管理 ============ */
  var INV_LABEL = { PENDING: '待处理', PROCESSING: '开票中', ISSUED: '已开具', REJECTED: '已驳回' };
  var INV_TAG = { PENDING: 'tag-p', PROCESSING: 'tag-a', ISSUED: 'tag-ok', REJECTED: '' };

  function viewInvoice() {
    var st = S.invStatus || 'PENDING';
    var q = '/admin/invoice/records?size=100' + (st === 'ALL' ? '' : '&status=' + st) + (S.storeId ? '&storeId=' + encodeURIComponent(S.storeId) : '');
    return api(q).then(function (d) {
      var rows = (d.list || []).map(function (r) {
        var acts = '';
        if (has('invoice:write')) {
          if (r.status === 'PENDING') acts += '<button class="btn btn-sm" data-inv="' + r.id + '" data-to="PROCESSING">受理</button> ';
          if (r.status === 'PENDING' || r.status === 'PROCESSING') {
            acts += '<button class="btn btn-sm btn-p" data-inv="' + r.id + '" data-to="ISSUED">开具</button> ';
            acts += '<button class="btn btn-sm btn-d" data-inv="' + r.id + '" data-to="REJECTED">驳回</button>';
          }
        }
        return '<tr><td><b>' + esc(r.title) + '</b><div style="font-size:11px;color:#999">' + esc(r.titleType === 'company' ? '公司' + (r.taxNo ? ' · ' + esc(r.taxNo) : '') : '个人') + '</div></td>' +
          '<td>¥' + fen(r.amount) + '</td>' +
          '<td style="font-size:12px">' + esc(r.orderNo) + '<div style="color:#999">' + esc(r.nickname || '') + '</div></td>' +
          '<td style="font-size:12px">' + esc(r.email) + '</td>' +
          '<td>' + esc(r.storeId || '') + '</td>' +
          '<td><span class="tag ' + (INV_TAG[r.status] || '') + '">' + (INV_LABEL[r.status] || r.status) + '</span>' +
          (r.invoiceNo ? '<div style="font-size:11px;color:#999">' + esc(r.invoiceNo) + '</div>' : '') +
          (r.remark ? '<div style="font-size:11px;color:#999">' + esc(r.remark) + '</div>' : '') + '</td>' +
          '<td style="font-size:12px">' + fmtTime(r.appliedAt) + '</td>' +
          '<td>' + (acts || '—') + '</td></tr>';
      }).join('');
      var tabs = ['PENDING', 'PROCESSING', 'ISSUED', 'REJECTED', 'ALL'].map(function (k) {
        return '<button class="btn btn-sm ' + (st === k ? 'btn-p' : '') + '" data-invst="' + k + '">' +
          (k === 'ALL' ? '全部' : INV_LABEL[k]) + '</button>';
      }).join(' ');
      shell('发票管理', '用户在小程序「我的 → 发票管理」提交的开票申请',
        '<div class="card"><div class="storebar">' + storeSelectorHtml(true) + '<span style="width:1px;height:20px;background:#eee"></span>' + tabs +
        '<button class="btn" id="invRefresh" style="margin-left:auto">刷新</button></div></div>' +
        '<div class="card"><div class="tbl-wrap"><table><thead><tr>' +
        '<th>抬头</th><th>金额</th><th>订单 / 用户</th><th>邮箱</th><th>门店</th><th>状态</th><th>申请时间</th><th>操作</th>' +
        '</tr></thead><tbody>' + (rows || '<tr><td colspan="8" class="empty">暂无开票申请</td></tr>') + '</tbody></table></div></div>');

      bindStoreSelector(function () { render(); });
      var rf = el('invRefresh');
      if (rf) rf.onclick = function () { render(); };
      Array.prototype.forEach.call(document.querySelectorAll('[data-invst]'), function (b) {
        b.onclick = function () { S.invStatus = b.dataset.invst; render(); };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-inv]'), function (b) {
        b.onclick = function () { updateInvoice(Number(b.dataset.inv), b.dataset.to); };
      });
    });
  }

  function updateInvoice(id, to) {
    if (to === 'ISSUED') {
      modal('开具发票', '<label class="f"><span>发票号码 / 文件地址（至少填一项，必填）</span><input type="text" id="invNo" placeholder="如 25117000000012345678"></label>' +
        '<label class="f"><span>发票文件地址（可选，PDF/图片 URL）</span><input type="text" id="invUrl" placeholder="/uploads/... 或 https://..."></label>' +
        '<label class="f"><span>备注（可选）</span><input type="text" id="invRemark" placeholder="如：已发送至邮箱"></label>',
        function () {
          var invoiceNo = (el('invNo').value || '').trim();
          var invoiceUrl = (el('invUrl').value || '').trim();
          if (!invoiceNo && !invoiceUrl) { toast('请填写发票号码或文件地址'); return false; }
          api('/admin/invoice/records/' + id + '/status', { method: 'POST', body: { status: 'ISSUED', invoiceNo: invoiceNo, invoiceUrl: invoiceUrl, remark: (el('invRemark').value || '').trim() } })
            .then(function () { toast('已开具'); render(); })
            .catch(function (e) { toast((e && e.message) || '操作失败'); });
          return true;
        }, '确认开具');
      return;
    }
    if (to === 'REJECTED') {
      modal('驳回开票申请', '<label class="f"><span>驳回原因（用户可见）</span><input type="text" id="invRemark" placeholder="如：抬头税号与订单主体不一致"></label>',
        function () {
          var remark = (el('invRemark').value || '').trim();
          if (!remark) { toast('请填写驳回原因'); return false; }
          api('/admin/invoice/records/' + id + '/status', { method: 'POST', body: { status: 'REJECTED', remark: remark } })
            .then(function () { toast('已驳回'); render(); })
            .catch(function (e) { toast((e && e.message) || '操作失败'); });
          return true;
        }, '确认驳回');
      return;
    }
    api('/admin/invoice/records/' + id + '/status', { method: 'POST', body: { status: to } })
      .then(function () { toast('已受理'); render(); })
      .catch(function (e) { toast((e && e.message) || '操作失败'); });
  }

  /* ============ 视图：加盟配置（小程序「我的 → 加盟咨询」海报） ============ */
  function viewFranchise() {
    return api('/admin/franchise').then(function (d) {
      var hs = (d.highlights || []).slice(0, 4);
      while (hs.length < 4) hs.push({ icon: '', label: '', value: '' });
      var rows = hs.map(function (h, i) {
        return '<div class="grid3">' +
          '<label class="f"><span>图标（emoji）</span><input type="text" id="fh' + i + '" value="' + esc(h.icon || '') + '"></label>' +
          '<label class="f"><span>指标名称</span><input type="text" id="fl' + i + '" value="' + esc(h.label || '') + '"></label>' +
          '<label class="f"><span>指标值</span><input type="text" id="fv' + i + '" value="' + esc(h.value || '') + '"></label>' +
          '</div>';
      }).join('');
      shell('加盟配置', '小程序「我的 → 加盟咨询」页面的海报文案与企业微信二维码',
        '<div class="card"><h3>海报内容<span class="sp">留空则使用内置版式</span></h3>' +
        '<div class="grid2">' +
        '<label class="f"><span>主标题</span><input type="text" id="fTitle" value="' + esc(d.title) + '"></label>' +
        '<label class="f"><span>副标题</span><input type="text" id="fSub" value="' + esc(d.subtitle) + '"></label>' +
        '</div>' +
        rows +
        '<div class="grid2">' +
        '<label class="f"><span>企业微信二维码地址（后台上传后填入，留空显示占位）</span><input type="text" id="fQr" value="' + esc(d.qrUrl) + '" placeholder="/uploads/... 或 https://..."></label>' +
        '<label class="f"><span>整张海报图地址（可选，配置后小程序直接展示该图）</span><input type="text" id="fPoster" value="' + esc(d.posterUrl) + '" placeholder="留空使用内置版式"></label>' +
        '</div>' +
        '<div class="grid2">' +
        '<label class="f"><span>二维码下方提示文案</span><input type="text" id="fTip" value="' + esc(d.qrTip) + '"></label>' +
        '<label class="f"><span>加盟咨询电话</span><input type="text" id="fPhone" value="' + esc(d.consultPhone) + '"></label>' +
        '</div>' +
        '<label class="f"><span>企业微信号（选填，展示用）</span><input type="text" id="fWecom" value="' + esc(d.wecomId) + '"></label>' +
        '<div class="row"><button class="btn btn-p" id="fSave">保存配置</button><span class="tag">最近更新：' + fmtTime(d.updatedAt) + '</span></div>' +
        '</div>');

      el('fSave').onclick = function () {
        var highlights = [];
        for (var i = 0; i < 4; i++) {
          var label = (el('fl' + i).value || '').trim();
          if (!label) continue;
          highlights.push({ icon: (el('fh' + i).value || '').trim(), label: label, value: (el('fv' + i).value || '').trim() });
        }
        var body = {
          title: (el('fTitle').value || '').trim(),
          subtitle: (el('fSub').value || '').trim(),
          highlights: highlights,
          qrUrl: (el('fQr').value || '').trim(),
          posterUrl: (el('fPoster').value || '').trim(),
          qrTip: (el('fTip').value || '').trim(),
          consultPhone: (el('fPhone').value || '').trim(),
          wecomId: (el('fWecom').value || '').trim(),
        };
        api('/admin/franchise', { method: 'PUT', body: body })
          .then(function () { toast('已保存，小程序端即时生效'); })
          .catch(function (e) { toast((e && e.message) || '保存失败'); });
      };
    });
  }

  /* ============ 视图：协议及政策（富文本维护） ============ */
  function viewAgreement() {
    return api('/admin/agreements').then(function (d) {
      var rows = (d.list || []).map(function (a) {
        return '<tr><td><b>' + esc(a.title) + '</b><div style="font-size:11px;color:#999">' + esc(a.code) + '</div></td>' +
          '<td style="font-size:12px">' + esc(a.summary || '') + '</td>' +
          '<td>' + esc(a.version) + '</td>' +
          '<td><span class="tag ' + (a.status ? 'tag-ok' : '') + '">' + (a.status ? '已上线' : '已下线') + '</span></td>' +
          '<td style="font-size:12px">' + fmtTime(a.updatedAt) + '</td>' +
          '<td>' + (has('content:write') ? '<button class="btn btn-sm btn-p" data-ag="' + esc(a.code) + '">编辑</button>' : '—') + '</td></tr>';
      }).join('');
      shell('协议及政策', '小程序「我的 → 协议及政策」展示内容 · 支持基础 HTML（h3/p/ul/li/b）',
        '<div class="card"><div class="tbl-wrap"><table><thead><tr>' +
        '<th>标题</th><th>摘要</th><th>版本</th><th>状态</th><th>更新时间</th><th>操作</th>' +
        '</tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="empty">暂无协议</td></tr>') + '</tbody></table></div>' +
        '<div class="hint" style="margin-top:12px;font-size:12px;color:#8a8a8e">提示：正文使用 HTML 片段，例如 &lt;h3&gt;一、标题&lt;/h3&gt;&lt;p&gt;内容&lt;/p&gt;；rich-text 只渲染白名单标签。</div></div>');

      Array.prototype.forEach.call(document.querySelectorAll('[data-ag]'), function (b) {
        b.onclick = function () { editAgreement(b.dataset.ag); };
      });
    });
  }

  function editAgreement(code) {
    api('/admin/agreements').then(function (d) {
      var a = (d.list || []).filter(function (x) { return x.code === code; })[0];
      if (!a) return toast('协议不存在');
      modal('编辑：' + a.title,
        '<div class="grid2">' +
        '<label class="f"><span>标题</span><input type="text" id="agTitle" value="' + esc(a.title) + '"></label>' +
        '<label class="f"><span>版本号</span><input type="text" id="agVer" value="' + esc(a.version) + '"></label>' +
        '</div>' +
        '<div class="grid2">' +
        '<label class="f"><span>列表摘要</span><input type="text" id="agSummary" value="' + esc(a.summary || '') + '"></label>' +
        '<label class="f"><span>排序（越小越靠前）</span><input type="number" id="agSort" value="' + (a.sort || 0) + '"></label>' +
        '</div>' +
        '<label class="f"><span>正文（HTML 片段）</span><textarea id="agHtml" style="min-height:260px;font-family:ui-monospace,Consolas,monospace">' + esc(a.contentHtml || '') + '</textarea></label>' +
        '<label class="f"><span>状态</span><select id="agStatus"><option value="1"' + (a.status ? ' selected' : '') + '>上线</option><option value="0"' + (a.status ? '' : ' selected') + '>下线</option></select></label>',
        function () {
          return api('/admin/agreements/' + encodeURIComponent(code), {
            method: 'PUT',
            body: {
              title: (el('agTitle').value || '').trim(),
              version: (el('agVer').value || '').trim(),
              summary: (el('agSummary').value || '').trim(),
              sort: Number(el('agSort').value) || 0,
              contentHtml: el('agHtml').value || '',
              status: el('agStatus').value === '1',
            },
          }).then(function () { toast('已保存，小程序端即时生效'); render(); });
        }, '保存');
    });
  }

  var VIEWS = {
    dashboard: viewDashboard, orders: viewOrders, voucher: viewVoucher, coupon: viewCoupon,
    theme: viewTheme, dish: viewDish, store: viewStore, staff: viewStaff, audit: viewAudit,
    service: viewService, invoice: viewInvoice, franchise: viewFranchise, agreement: viewAgreement,
  };

  function render() {
    if (!S.staff) return renderLogin();
    if (S.staff.mustChangePwd) return renderForcePwd();
    /* 切换视图时停掉上一个视图可能开着的轮询（客服消息），避免后台白跑请求 */
    if (S.svcTimer) { clearInterval(S.svcTimer); S.svcTimer = null; }
    var v = VIEWS[S.view] || viewDashboard;
    if (!has((MENU.filter(function (m) { return m.key === S.view; })[0] || {}).perm || 'stats:read')) {
      S.view = (MENU.filter(function (m) { return has(m.perm); })[0] || {}).key || 'dashboard';
      v = VIEWS[S.view];
    }
    Promise.resolve(v()).catch(function (e) {
      var msg = (e && e.message) || '加载失败';
      /* 服务端业务码是 40100（不是 HTTP 401），写错就永远不会触发登出 */
      if (e && (e.code === 40100 || e.code === 40300)) { toast('登录态已失效或权限不足'); logout(); return; }
      shell('出错了', '', '<div class="card"><div class="empty">' + esc(msg) + '</div></div>');
      toast(msg);
    });
  }

  function loadStores() {
    return api('/admin/stores?size=200').then(function (d) {
      S.stores = d.list || [];
      if (S.storeId && !S.stores.some(function (s) { return s.id === S.storeId; })) S.storeId = '';
      if (!S.storeId && S.stores.length) S.storeId = S.stores[0].id;
      return S.stores;
    });
  }

  function boot() {
    api('/admin/auth/profile')
      .then(function (p) {
        S.staff = {
          id: p.id, account: p.account, name: p.name, role: p.role, roleName: p.roleName,
          allStores: p.allStores, storeIds: p.storeIds, region: p.region,
          mustChangePwd: p.mustChangePwd, perms: p.perms, scope: p.scope,
        };
        S.view = (MENU.filter(function (m) { return has(m.perm); })[0] || {}).key || 'dashboard';
        if (S.staff.mustChangePwd) return renderForcePwd();
        return loadStores().then(render).catch(function () { render(); });
      })
      .catch(function () { logout(); });
  }

  /* 启动 */
  if (localStorage.getItem(LS.token)) boot();
  else renderLogin();
})();
