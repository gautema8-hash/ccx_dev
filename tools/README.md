# 工具脚本

均在**项目根目录**执行。脚本零依赖（除 `e2e-automator.js` / `admin-e2e.js` 需要 `miniprogram-automator`、`puppeteer-core`，已装在隔离工作区）。

| 脚本 | 用途 | 依赖 |
| --- | --- | --- |
| `audit-miniprogram.js` | 小程序静态审查 | 无 |
| `check-wxml-comments.js` | WXML 注释布局扫描（编译失败 / 界面静默少一块时用） | 无 |
| `build-preview.js` | 构建离线预览单文件 | 无 |
| `verify-preview.js` | 预览版回归（41 项） | 无 |
| `e2e-automator.js` | 模拟器端到端（204 项） | 微信开发者工具 + `miniprogram-automator` |
| `admin-e2e.js` | 商家后台端到端（31 项） | `admin-server` 运行中 + `puppeteer-core` |
| `shot-page.js` | 模拟器页面截图（改版对图/留证） | 微信开发者工具 + `miniprogram-automator` |

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

> 注意：**静态审查查不出 WXML 编译期错误，也查不出「节点被静默丢弃」**。这两类问题 audit 都报「全部通过」—— 分别见第 4 节与第 6 节。

---

## 2. `check-wxml-comments.js` —— WXML 注释布局扫描

```bash
node tools/check-wxml-comments.js    # WARN > 0 时退出码 1
```

WXML 编译器（实测版本 2.02.2608080）对注释的处理有两类**反直觉**行为，都会让界面悄无声息地少一块。本脚本给出 `WARN / INFO` 两级定位。

### 已验证的行为矩阵（均在模拟器上复现确认）

| 写法 | 结果 |
| --- | --- |
| **≥2 条相邻「多行」注释 + 紧随 `wx:if` 节点** | ❌ **其后所有条件节点被静默丢弃**（不报错、编译通过、`preview` 正常） |
| 2 条相邻「单行」注释 + `wx:if` | ✅ 正常 |
| 1 条注释（单行或多行） + `wx:if` | ✅ 正常 |
| 注释 + `wx:elif`/`wx:else`（条件属性在**开标签首行**） | ✅ 编译与渲染都正常 |
| 多行开标签、`wx:if` 写在**续行** | ✅ 正常 |
| `wx:elif` 写在多行标签的**续行** + 前置注释 | ❌ **编译直接失败**：`Bad attr 'wx:elif' with message: 'wx:if not found, then something must be wrong'`（整个项目白屏） |

### 规避写法

1. 同一层里**最多只放一条注释**；两条以上就地合并。
2. 条件属性（`wx:if/elif/else`）一律写在**开标签首行**，不要写在多行续行上。
3. 注释最好放在**下一个兄弟节点不是条件节点**的位置。

### 排查症状对照

| 症状 | 根因 |
| --- | --- |
| 整个项目白屏、`getApp()` 为 null、`getCurrentPages()` 为空 | 编译失败（多为 `wx:elif` 邻接/续行问题）→ 用 `cli.bat preview` 逼出错误行号 |
| 页面能开、数据也对，但某一块 UI 就是不出现 | 兄弟层「两条相邻多行注释」把后续 `wx:if` 节点全吞了 → 用本脚本定位 |

> 真实案例：「我的」页不显示用户名（`pages/mine/mine.wxml`）—— 数据里 `displayName = 串串香食客` 完全正确，`.ucard__main` 的兄弟层里有两条相邻多行注释，导致昵称/输入框/游客态三个 `wx:if` 节点全部没进 DOM。把两条注释合并成一条并移出该层后恢复正常。

---

## 3. `build-preview.js` / `verify-preview.js` —— 离线预览与回归

```bash
node tools/build-preview.js      # 产出 ../老北京麻辣串串香-点单小程序预览.html（约 155 KB）
node tools/verify-preview.js    # 41 项
```

把小程序业务模块内联进预览单文件：

- 内联 9 个模块：`mock/menu.js`、`mock/coupon.js`、`utils/{config,util,request,auth,cart}.js`、`services/{menu,order}.js`
- **只在构建产物里**把 `USE_MOCK` 强制为 `true`，源码不动

回归覆盖：模块加载与相对路径解析、菜单结构、Mock 登录、同串不同辣度分两行、锅底/打包费、优惠券抵扣、状态机推进与时间轴、订单列表筛选、再来一单回填、UI 层 `A.xxx` 处理器静态对账。

---

## 4. `e2e-automator.js` —— 模拟器端到端

```bash
# 前置一：微信开发者工具 → 设置 → 安全设置 → 服务端口 开启
# 前置二：IDE 必须由**用户手动启动**（沙箱会拦截 IDE 启动时调用的 reg.exe）

# 前置三：打开自动化通道
"D:/sofa/wxdevtools/微信web开发者工具/cli.bat" auto \
  --project "<项目根>/miniprogram" --auto-port 9420

# 然后（E2E_RESET=1 会先清掉地址/客服/开票的测试数据，保证可重复跑）
E2E_RESET=1 node tools/e2e-automator.js
```

覆盖 19 个段落：菜单首屏与分类联动、辣度弹层、购物车与锅底、结算与优惠券、下单支付、订单详情与再来一单、券中心、核销、我的页分组入口、收货地址、在线客服、协议及政策、加盟咨询、门店筛选与详情、发票管理全流程。

### 实测边界（`miniprogram-automator` 0.12.1）

| 坑 | 现象 | 解法 |
| --- | --- | --- |
| `automator.launch()` 在 Windows 失败 | `Failed to launch wechat web devTools` | 两步走：先 `cli.bat auto`，再 `automator.connect({ wsEndpoint })` |
| **`getElementByXpath` 匹配失败返回「假元素」** | 断言 `!!el` 恒为真；连 `ZZZZ_NOT_EXIST` 都能「命中」，`.text()` 返回 `''`、`.wxml()` 抛错、`offset()` 恒为 `{0,0}` | 真元素有 `tagName`，假元素 `tagName === undefined`。本项目把它封装进 `elOf()` 统一过滤 |
| CSS 选择器穿不过自定义组件 | `page.$('stepper')` 为 null | 组件内部改用 **XPath** |
| `contains(@class,"sku-opt")` 撞前缀 | 连带命中 `.sku-opts`、`.sku-opt__dot` | 精确 token：`contains(concat(" ",normalize-space(@class)," ")," sku-opt ")` |
| `getElementsByXpath` 未实现 | 返回 undefined | 只用 `getElementByXpath` + 下标谓词 `(//*[...])[n]` |
| **`TXC` 与 `TXTIN` 选错** | 文案直接写在元素上时（`<view class="panel__item">直营店</view>`），`TXTIN`（class 容器 + **后代**文案）匹配不到 | 文案直接写在元素上 → 用 `TXC`（class + **自身**文案）；文案在子 `<text>` 里 → 才用 `TXTIN` |
| `page.callMethod` 不可用 | `this.resetLocal is not a function` | 改为点真实控件 |
| Storage 清不掉购物车 | `removeStorageSync('lbz_cart_v1')` 后件数不变 | `utils/cart.js` 的 `state` 是模块级内存缓存，必须走 UI「我的 → 清除本地缓存」 |
| 组件内元素 `offset()` 返回 `0,0` | 步进器点不动 | 已知覆盖缺口：无规格菜品的列表步进器需人工确认 |
| `touristappid` 被拒 | `[automation_game] formatProject reject tourist/empty appid` | 必须填真实（或测试号）AppID |
| 断言受「自动匹配最近门店」影响 | 模拟器定位漂到丰台店 → 菜品数 28 而非 30 | 用例开头把定位/门店钉死（写 `lbz_location_v1` 并清 `lbz_store_v1`），测试必须与环境无关 |
| **跑测试期间不要写项目文件** | 写入会触发 IDE 重编译，正在跑的用例会莫名超时/点不动 | 一个用例跑完再改文件；批量改完等 6~8 秒再跑 |

### 排查：模拟器起不来（点不动、`getCurrentPages()` 为空）

按顺序做这几步，不要瞎猜：

1. **看编译错误**（最常见）——IDE 里用户代码没跑起来、`getApp()` 为 null，八成是**编译失败**。用以下命令逼出错误信息：
   ```bash
   ./cli.bat preview --project "<项目根>/miniprogram" --qr-format terminal
   ```
   输出里的 `wxml 编译错误，错误信息：./pages/xxx/xxx.wxml:1:496: Bad attr ...` 就是根因。
2. **看服务端**：`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/...`，返回码而非连接错误说明服务在跑。
3. **确认通道正常**：`automator.connect` 后 `wx.getSystemInfoSync().platform === 'devtools'`；再用一个最小项目做对照（本项目实测过，最小项目能跑通说明通道没问题，问题在项目代码）。
4. **重启会话**：`cli.bat close --project <path>` 再 `open`，最后重新 `auto`。

> **注意**：`getApp()` 返回 `null` + `__wxAppData` 为空 + 路由栈为空，是「**项目编译失败**」的典型指纹，而不是 IDE 坏了。此时 IDE 日志里通常**没有**编译错误（错误只在 IDE 界面或 `cli.bat preview` 的输出里）。

### 排查：跑到一半 `navigateBack` 失效 / 莫名超时

**症状**：某个用例断言 `wx.navigateBack` 后没返回（例如「选券 → 自动返回结算页」停在原页），随后 `timeout waiting for automator response`；重跑同样的用例仍然失败，且**失败点会越来越靠前**。

**这不是代码问题**，是开发者工具**长时间自动化会话后路由层劣化**。判据在 IDE 日志（`%LOCALAPPDATA%/微信开发者工具/User Data/<hash>/WeappLog/logs/*.log`）：

```
[ERROR] routeTo navigateTo timeout
[ERROR] !!! triggerAppRouteDone timeout { routeType: 'navigateTo' }
```

**归因方法（避免误改产品代码）**：把改动 `git checkout HEAD --` 临时还原后再跑一次，若同样失败 → 与本次改动无关。

**处理**：重启开发者工具项目窗口（`cli.bat close` + `open` + `auto`）。若仍不稳定，需要**完全退出开发者工具再重新打开**（进程级状态无法靠关窗口清掉）。恢复后用例应回到 204/204。

---

## 5. `admin-e2e.js` —— 商家后台端到端

```bash
# 前置：admin-server 与 miniprogram-server 都已启动
node tools/admin-e2e.js    # 31 项
```

覆盖登录鉴权、侧边菜单（13 个子系统）、门店选择器、各视图关键元素。

---

## 6. `shot-page.js` —— 模拟器截图

```bash
node tools/shot-page.js pages/mine/mine                  # → shot-pages-mine-mine.png
node tools/shot-page.js pages/menu/menu shot-menu.png    # 指定输出路径
```

改版对图、留证用。`screenshot` 偶尔超时（大屏渲染慢），重跑一次即可。

---

## 环境提示

| 项 | 说明 |
| --- | --- |
| Node 依赖隔离 | `miniprogram-automator` / `puppeteer-core` 装在隔离工作区，脚本通过 `module.paths.push(...)` 注入，**不污染项目** |
| 绝对路径 | `e2e-automator.js` 里的开发者工具路径需按本机实际安装位置调整 |
| Node 版本 | 用受管 Node：`C:/Users/xuyan/.workbuddy/binaries/node/versions/22.22.2-6/node.exe` |
| IDE 启动 | **沙箱不允许自动化启动 IDE**（会调 `reg.exe`，被安全策略拦截），必须由用户手动打开 |
| IDE 日志 | `%LOCALAPPDATA%/微信开发者工具/User Data/<hash>/WeappLog/logs/*.log`，路由/编译问题优先看这里 |
