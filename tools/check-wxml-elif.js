/**
 * WXML 条件渲染邻接规则检查（一次性排查脚本）
 *   node tools/check-wxml-elif.js
 *
 * 规则：wx:elif / wx:else 必须紧邻同一父节点下、前面最近的兄弟元素（wx:if / wx:elif）。
 *      中间只要有注释节点，WXML 编译器就会报
 *      "Bad attr `wx:elif` ... wx:if not found"，进而导致整个项目编译失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'miniprogram');

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.wxml')) out.push(p);
  }
  return out;
}

const files = walk(ROOT, []);
console.log(`扫描 ${files.length} 个 wxml 文件\n`);

let total = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);

  /* 先标注每行的注释归属 */
  let inComment = false;
  const lineKind = lines.map((ln) => {
    const startedInComment = inComment;
    /* 简易状态机：处理本行内的注释开合 */
    let i = 0;
    let localIn = inComment;
    while (i < ln.length) {
      if (!localIn) {
        const open = ln.indexOf('<!--', i);
        if (open === -1) break;
        const close = ln.indexOf('-->', open + 4);
        if (close === -1) { localIn = true; break; }
        i = close + 3;
      } else {
        const close = ln.indexOf('-->', i);
        if (close === -1) break;
        localIn = false;
        i = close + 3;
      }
    }
    inComment = localIn;
    /* 判定：整行都在注释里（或注释结束后的剩余部分无标签） */
    const trimmed = ln.trim();
    if (trimmed.startsWith('<!--') || (startedInComment && trimmed === '')) return 'comment';
    if (startedInComment && !trimmed.startsWith('-->')) return 'comment';
    return 'code';
  });

  /* 找 wx:elif / wx:else */
  for (let n = 0; n < lines.length; n++) {
    const ln = lines[n];
    const m = /wx:(elif|else)\b/.exec(ln);
    if (!m) continue;
    /* 向前回溯：跳过空白行 */
    let k = n - 1;
    while (k >= 0 && lines[k].trim() === '') k--;
    if (k < 0) continue;
    if (lineKind[k] === 'comment') {
      total++;
      console.log(`✗ ${rel}:${n + 1}  wx:${m[1]} 被注释隔开（前置节点在 ${rel}:${k + 1}）`);
      console.log(`    前置注释：${lines[k].trim().slice(0, 70)}`);
      console.log(`    当前行  ：${ln.trim().slice(0, 70)}\n`);
    }
  }
}

console.log(total ? `\n共发现 ${total} 处可能导致编译失败的问题` : '\n✓ 未发现 wx:elif / wx:else 被注释隔开的问题');
process.exit(total ? 1 : 0);
