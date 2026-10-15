/**
 * 模拟器页面截图（需先手动打开微信开发者工具并加载本项目）
 *
 * 用法：
 *   <node> tools/shot-page.js pages/mine/mine
 *   <node> tools/shot-page.js pages/menu/menu shot-menu.png
 *   <node> tools/shot-page.js pages/mine/mine docs/assets/mine-phone.png 480   # 第 4 参 = 滚动距离(px)
 *
 * 说明：automator 的 screenshot 偶尔会超时（大屏渲染慢），重跑一次即可。
 *       长页面（如「我的」）要拍下半屏时传滚动距离，否则只截首屏。
 */
const path = require('path');
const WS = 'ws://127.0.0.1:9420';

module.paths.push('C:\\Users\\xuyan\\.workbuddy\\binaries\\node\\workspace\\node_modules');
const automator = require('miniprogram-automator');

const route = process.argv[2] || 'pages/mine/mine';
const out = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.resolve(__dirname, '..', 'shot-' + route.replace(/\//g, '-') + '.png');
const scrollTop = Number(process.argv[4] || 0);

(async () => {
  const mini = await automator.connect({ wsEndpoint: WS });
  const page = await mini.reLaunch('/' + route.replace(/^\//, ''));
  await page.waitFor(2500);
  if (scrollTop > 0) {
    await mini.pageScrollTo(scrollTop);
    await page.waitFor(800);
  }
  await mini.screenshot({ path: out });
  console.log('screenshot ->', out + (scrollTop ? '  (scrollTop=' + scrollTop + ')' : ''));
  await mini.disconnect();
  process.exit(0);
})().catch((e) => { console.error('SHOT FAIL:', e && e.message); process.exit(1); });
