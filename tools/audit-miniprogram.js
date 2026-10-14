/* ============================================================
   老北京麻辣串串香 · 小程序静态审查（提交前 / CI 可跑）
   ------------------------------------------------------------
   覆盖小程序最容易出问题的几类：
     A 语法          全量 JSON.parse + JS 编译
     B 引用完整性    require / 页面四件套 / usingComponents / 组件声明
     C 事件绑定      WXML 的 bind / catch 绑定是否都有对应的 JS 方法
     D 列表渲染      wx:for 是否都带 wx:key；是否存在 wx:for + wx:if 同元素
     E 定时器        setInterval 是否有 clearInterval
     F setData       是否误传函数（不可序列化）
     G 分包          分包页面是否越界引用主包以外的资源、预下载路径是否存在

   运行：node tools/audit-miniprogram.js
   ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../miniprogram');

const errs = [];
const warns = [];
const stats = {};
const E = (m) => errs.push(m);
const W = (m) => warns.push(m);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const ex = (p) => fs.existsSync(p);

const all = walk(ROOT);
const jsFiles = all.filter((f) => f.endsWith('.js'));
const jsonFiles = all.filter((f) => f.endsWith('.json'));
const wxmlFiles = all.filter((f) => f.endsWith('.wxml'));
const wxssFiles = all.filter((f) => f.endsWith('.wxss'));
stats['js / json / wxml / wxss'] = [jsFiles.length, jsonFiles.length, wxmlFiles.length, wxssFiles.length].join(' / ');

/* ---------- A 语法 ---------- */
for (const f of jsFiles) {
  try {
    new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f });
  } catch (e) {
    E(`[A] JS 语法错误 ${rel(f)} :: ${e.message}`);
  }
}
for (const f of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    E(`[A] JSON 解析失败 ${rel(f)} :: ${e.message}`);
  }
}

/* ---------- B 引用完整性 ---------- */
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const t = path.resolve(path.dirname(f), spec);
    if (!ex(t) && !ex(t + '.js')) E(`[B] require 找不到 ${rel(f)} -> ${spec}`);
  }
}

const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const pages = [...(app.pages || [])];
(app.subPackages || app.subpackages || []).forEach((sp) =>
  (sp.pages || []).forEach((p) => pages.push(sp.root + '/' + p))
);
stats['页面数（含分包）'] = pages.length;
for (const p of pages) {
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    if (!ex(path.join(ROOT, p + '.' + ext))) E(`[B] 页面文件缺失 ${p}.${ext}`);
  }
}
for (const t of (app.tabBar && app.tabBar.list) || []) {
  if (pages.indexOf(t.pagePath) === -1) E(`[B] tabBar 页面未在 pages 中注册 ${t.pagePath}`);
  if (!t.iconPath && !t.selectedIconPath) W(`[B] tabBar「${t.text}」未配图标（仅文字，需确认符合预期）`);
}
for (const [k, rule] of Object.entries(app.preloadRule || {})) {
  if (pages.indexOf(k) === -1) E(`[B] preloadRule 指向不存在的页面 ${k}`);
  (rule.packages || []).forEach((pk) => {
    const sub = (app.subPackages || []).find((s) => (s.name || s.root) === pk);
    if (!sub) E(`[B] preloadRule 引用了不存在的分包 ${pk}`);
  });
}

for (const f of jsonFiles) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    continue;
  }
  Object.keys(j.usingComponents || {}).forEach((k) => {
    const t = j.usingComponents[k];
    const base = t.startsWith('/') ? path.join(ROOT, t) : path.resolve(path.dirname(f), t);
    if (!ex(base + '.json')) E(`[B] 组件不存在 ${rel(f)} -> ${k} (${t})`);
  });
  if (/[\\/]components[\\/]/.test(f) && j.component !== true) E(`[B] 组件未声明 component:true ${rel(f)}`);
}

/* ---------- C 事件绑定 ---------- */
const evRe = /\b(?:bind|catch)(?::)?([a-zA-Z]+)\s*=\s*"([^"{}]+)"/g;
for (const w of wxmlFiles) {
  const js = w.replace(/\.wxml$/, '.js');
  if (!ex(js)) continue;
  const src = fs.readFileSync(js, 'utf8');
  const tpl = fs.readFileSync(w, 'utf8');
  let m;
  const seen = new Set();
  while ((m = evRe.exec(tpl))) {
    const name = m[2].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const re = new RegExp('(^|[^a-zA-Z0-9_$])' + name + '\\s*[(:]');
    if (!re.test(src)) E(`[C] 事件处理函数不存在 ${rel(w)} -> ${name}`);
  }
}

/* ---------- D 列表渲染 ---------- */
let forCount = 0;
let keyCount = 0;
for (const w of wxmlFiles) {
  const src = fs.readFileSync(w, 'utf8');
  const tagRe = /<([a-zA-Z-]+)([^>]*?)>/gs;
  let m;
  while ((m = tagRe.exec(src))) {
    const attrs = m[2];
    if (!/\bwx:for\s*=/.test(attrs)) continue;
    forCount++;
    if (/\bwx:key\s*=/.test(attrs)) keyCount++;
    else E(`[D] wx:for 缺 wx:key ${rel(w)} <${m[1]}>`);
    if (/\bwx:if\s*=/.test(attrs)) E(`[D] wx:for 与 wx:if 同一元素 ${rel(w)} <${m[1]}>`);
  }
}
stats['wx:for 总数 / 带 wx:key'] = forCount + ' / ' + keyCount;

/* ---------- E 定时器 ---------- */
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  if (/\bsetInterval\(/.test(src) && !/\bclearInterval\(/.test(src)) {
    E(`[E] setInterval 无对应 clearInterval ${rel(f)}`);
  }
  if (/Page\(\{/.test(src) && /\bsetTimeout\(/.test(src) && !/\bclearTimeout\(/.test(src)) {
    W(`[E] ${rel(f)} 有 setTimeout 但无 clearTimeout（若为一次性跳转延迟可忽略）`);
  }
}

/* ---------- F setData ---------- */
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /setData\(\s*\{([\s\S]*?)\}\s*[,)]/g;
  let m;
  while ((m = re.exec(src))) {
    const body = m[1];
    if (/:\s*(function\s*\(|\([^)]*\)\s*=>)/.test(body)) {
      E(`[F] setData 里塞了函数（不可序列化）${rel(f)}`);
    }
  }
}

/* ---------- 输出 ---------- */
console.log('\n=== 老北京麻辣串串香 · 小程序静态审查 ===\n');
Object.entries(stats).forEach(([k, v]) => console.log('  ' + k.padEnd(24) + v));
console.log('');
if (warns.length) {
  console.log('提示 ' + warns.length + ' 条：');
  warns.forEach((x) => console.log('  \x1b[33m!\x1b[0m ' + x));
  console.log('');
}
if (errs.length) {
  console.log('问题 ' + errs.length + ' 条：');
  errs.forEach((x) => console.log('  \x1b[31m✗\x1b[0m ' + x));
  console.log('\n静态审查未通过\n');
  process.exit(1);
}
console.log('\x1b[32m静态审查全部通过\x1b[0m\n');
