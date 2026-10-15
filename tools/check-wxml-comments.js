/**
 * WXML 注释安全扫描（全量 .wxml）
 *
 * 实测环境：微信开发者工具 2.02.2608080（全部结论都在真机模拟器上复现过）
 *
 * 已验证的行为矩阵：
 *   ≥2 条相邻「多行」注释 + wx:if 节点   → ❌ 其后所有条件节点被【静默丢弃】
 *                                         （不报错、编译通过、preview 正常，界面直接少一块）
 *   2 条相邻「单行」注释 + wx:if 节点     → ✅ 正常
 *   1 条注释（无论单行多行）+ wx:if 节点  → ✅ 正常
 *   注释 + wx:elif/wx:else（属性在首行）  → ✅ 编译与渲染都正常
 *   多行开标签、wx:if 写在续行            → ✅ 正常
 *   wx:elif 写在多行标签的【续行】+ 前置注释 → ❌ 编译直接失败：
 *       Bad attr 'wx:elif' with message: 'wx:if not found, then something must be wrong'
 *
 * 用法：node tools/check-wxml-comments.js
 * 退出码：有 WARN 时为 1，否则 0
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'miniprogram');
const COND = /\bwx:(if|elif|else)\b/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== '.git') walk(p, out);
    } else if (e.name.endsWith('.wxml')) out.push(p);
  }
  return out;
}

/** 把源码解析成同层「注释 / 节点」序列（多行开标签自动收拢） */
function parse(lines) {
  const seq = [];
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inComment) {
      seq[seq.length - 1].end = i + 1;
      if (t.includes('-->')) inComment = false;
      continue;
    }
    if (t.startsWith('<!--')) {
      const closes = t.indexOf('-->', 4) >= 0;
      seq.push({ type: 'comment', line: i + 1, end: i + 1, ml: !closes });
      if (!closes) inComment = true;
      continue;
    }
    if (t.startsWith('<') && !t.startsWith('</')) {
      const firstLine = t;
      let tag = t;
      let j = i;
      while (!tag.endsWith('>') && j + 1 < lines.length) {
        j++;
        tag += ' ' + lines[j].trim();
        if (tag.length > 900) break;
      }
      const m = COND.exec(tag);
      seq.push({
        type: 'node',
        line: i + 1,
        end: j + 1,
        multi: j > i,
        cond: m ? m[0] : null,
        condOnFirstLine: m ? COND.test(firstLine) : false,
        text: tag.slice(0, 96),
      });
      i = j;
      continue;
    }
  }
  return seq;
}

function scanFile(file) {
  const seq = parse(fs.readFileSync(file, 'utf8').split('\n'));
  const found = [];
  for (let i = 0; i < seq.length; i++) {
    if (seq[i].type !== 'comment') continue;
    const run = [];
    let j = i;
    while (j < seq.length && seq[j].type === 'comment') { run.push(seq[j]); j++; }
    const next = seq[j];
    i = j - 1;
    if (!next || next.type !== 'node' || !next.cond) continue;

    const hasMl = run.some((c) => c.ml);
    const at = `L${run[0].line}${run.length > 1 ? '-' + run[run.length - 1].end : ''} → L${next.line}`;

    if (run.length >= 2 && hasMl) {
      found.push({
        level: 'WARN',
        at,
        msg: `${run.length} 条相邻注释（含多行）→ 其后的 ${next.cond} 节点会被编译器静默丢弃，请合并为一条或移出该层`,
        text: next.text,
      });
    } else if ((next.cond === 'wx:elif' || next.cond === 'wx:else') && !next.condOnFirstLine) {
      found.push({
        level: 'WARN',
        at,
        msg: `${next.cond} 写在多行标签的续行上，且前面有注释 → 实测会编译失败，请把条件属性提到开标签首行`,
        text: next.text,
      });
    } else {
      found.push({
        level: 'INFO',
        at,
        msg: `注释在 ${next.cond} 之前（实测安全；建议条件属性保持在开标签首行）`,
        text: next.text,
      });
    }
  }
  return found;
}

const files = walk(ROOT);
let warns = 0;
let infos = 0;

for (const f of files) {
  const found = scanFile(f);
  if (!found.length) continue;
  const rel = path.relative(path.resolve(__dirname, '..'), f).replace(/\\/g, '/');
  console.log('\n' + rel);
  for (const x of found) {
    if (x.level === 'WARN') warns++;
    else infos++;
    console.log(`  [${x.level}] ${x.at}  ${x.msg}`);
    console.log(`         ${x.text}`);
  }
}

console.log(`\n扫描 ${files.length} 个 .wxml：WARN ${warns} / INFO ${infos}`);
process.exit(warns > 0 ? 1 : 0);
