/**
 * 模拟器页面截图（需先手动打开微信开发者工具并加载本项目）
 *
 * 用法：
 *   <node> tools/shot-page.js pages/mine/mine
 *   <node> tools/shot-page.js pages/menu/menu shot-menu.png
 *
 * 说明：automator 的 screenshot 偶尔会超时（大屏渲染慢），重跑一次即可。
 */
const path = require('path');
const WS = 'ws://127.0.0.1:9420';

module.paths.push('C:\\Users\\xuyan\\.workbuddy\\binaries\\node\\workspace\\node_modules');
const automator = require('miniprogram-automator');

const route = process.argv[2] || 'pages/mine/mine';
const out = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.resolve(__dirname, '..', 'shot-' + route.replace(/\//g, '-') + '.png');

(async () => {
  const mini = await automator.connect({ wsEndpoint: WS });
  const page = await mini.reLaunch('/' + route.replace(/^\//, ''));
  await page.waitFor(2500);
  await mini.screenshot({ path: out });
  console.log('screenshot ->', out);
  await mini.disconnect();
  process.exit(0);
})().catch((e) => { console.error('SHOT FAIL:', e && e.message); process.exit(1); });
