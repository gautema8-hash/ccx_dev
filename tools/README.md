# 工具脚本

均在**项目根目录**执行。脚本零依赖（除 `e2e-automator.js` 需要 `miniprogram-automator`，已装在隔离工作区）。

| 脚本 | 用途 | 依赖 |
| --- | --- | --- |
| `audit-miniprogram.js` | 小程序静态审查 | 无 |
| `build-preview.js` | 构建离线预览单文件 | 无 |
| `verify-preview.js` | 预览版回归（41 项） | 无 |
| `e2e-automator.js` | 模拟器端到端（82 项） | 微信开发者工具 + `miniprogram-automator` |

---

## 1. `audit-miniprogram.js` —— 静态审查

```bash
node tools/audit-miniprogram.js
```

| 检查项 | 说明 |
| --- | --- |
| 语法 | 全部 `.js` / `.json` 解析 |
| 引用完整性 | `require` 路径、页面四件套（js/json/wxml/wxss）、`usingComponents` |
| 模板 | `wx:for` 是否带 `wx:key`；`wx:for` 与 `wx:if` 是否同元素 |
| 事件 | WXML 绑定的事件名是否在 JS 中有对应方法 |
| 风险 | `setTimeout` 是否有 `clearTimeout`；`setData` 是否传入过大对象 |
| 分包 | `subPackages` / `preloadRule` 配置合法性 |

输出 `error / 提示` 两级：`error` 必须修；`提示` 需人工判断是否可接受。

---

## 2. `build-preview.js` —— 构建预览版

```bash
node tools/build-preview.js
```

把小程序业务模块内联进 `../老北京麻辣串串香-点单小程序预览.html`（约 152 KB）。

- 内联 9 个模块：`mock/menu.js`、`mock/coupon.js`、`utils/{config,util,request,auth,cart}.js`、`services/{menu,order}.js`
- **只在构建产物里**把 `USE_MOCK` 强制为 `true`，源码不动

---

## 3. `verify-preview.js` —— 预览版回归

```bash
node tools/verify-preview.js    # 41 项
```

覆盖：模块加载与相对路径解析、菜单结构、Mock 登录、同串不同辣度分两行、锅底/打包费、优惠券抵扣、状态机推进与时间轴、订单列表筛选、再来一单回填、UI 层 `A.xxx` 处理器静态对账。

---

## 4. `e2e-automator.js` —— 模拟器端到端

```bash
# 前置（只需一次）：微信开发者工具 → 设置 → 安全设置 → 服务端口 开启
"D:/sofa/wxdevtools/微信web开发者工具/cli.bat" auto \
  --project "<项目根>/lbz-chuanchuan" --auto-port 9420

# 然后
node tools/e2e-automator.js
```

### 实测边界（`miniprogram-automator` 0.12.1）

| 坑 | 现象 | 解法 |
| --- | --- | --- |
| `automator.launch()` 在 Windows 失败 | `Failed to launch wechat web devTools` | 两步走：先 `cli.bat auto`，再 `automator.connect({ wsEndpoint })` |
| CSS 选择器穿不过自定义组件 | `page.$('stepper')` 为 null | 组件内部改用 **XPath** |
| `contains(@class,"sku-opt")` 撞前缀 | 连带命中 `.sku-opts`、`.sku-opt__dot` | 精确 token：`contains(concat(" ",normalize-space(@class)," ")," sku-opt ")` |
| `getElementsByXpath` 未实现 | 返回 undefined | 只用 `getElementByXpath` + 下标谓词 `(//*[...])[n]` |
| `page.callMethod` 不可用 | `this.resetLocal is not a function` | 改为点真实控件 |
| Storage 清不掉购物车 | `removeStorageSync('lbz_cart_v1')` 后件数不变 | `utils/cart.js` 的 `state` 是模块级内存缓存，必须走 UI「我的 → 清除本地缓存」 |
| 组件内元素 `offset()` 返回 `0,0` | 步进器点不动 | 已知覆盖缺口：无规格菜品的列表步进器需人工确认 |
| `touristappid` 被拒 | `[automation_game] formatProject reject tourist/empty appid` | 必须填真实（或测试号）AppID |

---

## 环境提示

| 项 | 说明 |
| --- | --- |
| Node 依赖隔离 | `miniprogram-automator` 装在隔离工作区，脚本通过 `module.paths.push(...)` 注入，**不污染项目** |
| 绝对路径 | `e2e-automator.js` 里的开发者工具路径需按本机实际安装位置调整 |
