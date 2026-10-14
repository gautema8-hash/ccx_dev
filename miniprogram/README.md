# miniprogram/ · 小程序前端（顾客端）

微信小程序**原生框架**（无 npm 依赖、无 TDesign、无 uni-app），用微信开发者工具直接打开即可运行。

> 🏗️ 本目录是「四个独立目录」拆分之一：小程序前端。后端在 [`../miniprogram-server/`](../miniprogram-server/)，
> 管理端前端在 [`../admin-web/`](../admin-web/)，管理端后端在 [`../admin-server/`](../admin-server/)。

- 默认 `USE_MOCK = true`，**不配后端也能跑通**「浏览 → 选串加购 → 选辣度 → 购物车 → 结算下单 → 模拟支付 → 订单状态流转」全链路。
- 切到真实后端后支持：**多门店（直营/加盟）+ 定位 + 主题换肤 + 优惠券 + 美团团购券核销**。

> 还没装微信开发者工具？工作区根目录有**同源预览版** `老北京麻辣串串香-点单小程序预览.html`，
> 双击即可用浏览器走完点单主流程（业务逻辑直接复用本工程的 `utils/ services/ mock/`，非重写 Demo）。
> 源码改动后执行 `node tools/build-preview.js` 重新生成。

> 完整文档见项目根目录 `docs/`（需求 / 架构 / 接口 / 运维 / 交付说明 / 管理后台说明 / 审查 / 测试）。

**职责边界**：客户端只负责「展示与传递意图」，价格 / 优惠 / 库存 / 订单状态一律以服务端为准。
金额全程用「分」整数，仅展示层转元。

---

## 一、3 分钟跑起来

1. 打开 **微信开发者工具** → 「导入项目」
2. 目录选择本文件夹（`miniprogram`）
3. AppID：`project.config.json` 里填的是 `wx80a1dafad4c8a193`（测试号）；换成自己的 AppID 后可用于真机预览
   > ⚠️ 不要用 `touristappid`（游客模式）—— 开发者工具的**自动化测试层会直接拒绝**游客 AppID
4. 编译即可。首次进入自动静默登录并加载默认门店菜单

### 自动化测试

```bash
# 静态审查（无需开发者工具）
node tools/audit-miniprogram.js

# 预览版回归 41 项（无需开发者工具）
node tools/build-preview.js && node tools/verify-preview.js

# 模拟器端到端 82 项（前置：设置 → 安全设置 → 服务端口 开启）
"D:/sofa/wxdevtools/微信web开发者工具/cli.bat" auto \
  --project "D:/sofa/aiproject/workBuddyWork/ccx_dev/miniprogram" --auto-port 9420
node tools/e2e-automator.js
```

> **注意**：`wx.removeStorageSync('lbz_cart_v1')` 清不掉购物车 ——
> `utils/cart.js` 的 `state` 是模块级内存缓存，必须走「我的 → 清除本地缓存」（内部调 `cart.clearAll()`）。

### 真机预览

- 工具栏「预览」→ 手机微信扫码
- **必须先填真实 AppID**（测试号不支持真机预览）
- 接真实后端后**必须**在「开发管理 → 服务器域名」配置 `request` 合法域名

---

## 二、目录结构

```
miniprogram/
├── app.js / app.json / app.wxss      # 全局：静默登录、购物车角标、tabBar、分包与预下载
├── project.config.json               # compileType / libVersion / 编译条件
├── sitemap.json                      # 确认页、详情页不被微信索引
│
├── pages/                            # 主包（8 页）
│   ├── menu/                         # 点单：分类联动 + 规格弹层 + 悬浮购物车条 + 主题横幅
│   ├── cart/                         # 购物车：锅底/蘸料/明细增减/金额
│   ├── orders/                       # 订单列表：状态筛选 + 下拉刷新
│   ├── order-detail/                 # 订单详情：状态时间轴 + 取餐码 + 轮询
│   ├── confirm/                      # 结算：优惠券 + 提交 + 支付
│   ├── mine/                         # 我的：头像昵称 + 权益入口 + 门店切换 + 团购券核销
│   ├── store-list/                   # 【连锁】门店列表：定位 + 距离排序 + 直营/加盟筛选 + 导航
│   └── voucher/                      # 【连锁】美团团购券自助核销
│
├── packageUser/                      # 分包（成长型页面）
│   └── pages/coupon/                 # 优惠券：领券中心 / 我的券 / 结算选券
│
├── components/
│   ├── stepper/                      # 数量步进器
│   └── sku-popup/                    # 口味辣度规格弹层
│
├── services/                         # 服务层（页面只依赖这里）
│   ├── menu.js                       # 菜单 + 按门店隔离的 60s 内存缓存
│   ├── order.js                      # 订单 + 状态机
│   ├── user.js                       # 用户资料与统计
│   └── chain.js                      # 【连锁】定位/门店/主题/领券/核销
│
├── utils/
│   ├── config.js                     # 环境开关：USE_MOCK / MOCK_PAY / BASE_URL
│   ├── request.js                    # 统一请求：token 注入、401 重登重放、并发去重、离线快速失败
│   ├── auth.js                       # 静默登录、登录态校验
│   ├── cart.js                       # 购物车状态中心（发布订阅 + 本地持久化 + 按门店校正）
│   └── util.js                       # 分元换算、时间格式化、节流
│
└── mock/
    ├── menu.js                       # 6 分类 / 30 菜品 / 4 锅底 / 4 蘸料 / 4 档辣度
    └── coupon.js                     # 优惠券 + 抵扣计算（仅 Mock 模式用）
```

### 分层规则（强制）

```
页面/组件 → services → utils/request → 后端 API
                ↓
              mock（仅 USE_MOCK 时）
```

| 禁止 | 原因 |
| --- | --- |
| 页面直接 `wx.request` | 绕过统一鉴权、重试、错误处理 |
| 页面直接读 `mock/` | 真实后端与 mock 切换会失控 |
| WXML 里计算价格 | 价格必须由服务端给，或服务端口径 |
| 页面自行判断券是否可用 | 抵扣口径必须走服务端，避免"显示可用、下单不可用" |

---

## 三、体验路径（建议按此顺序验收）

| 步骤 | 操作 | 预期 |
| --- | --- | --- |
| 1 | 点单页左侧点「串串 · 素」 | 右侧自动滚到对应区块，左侧高亮跟随 |
| 2 | 右侧滚动到「饮品」 | 左侧高亮自动切到「饮品」 |
| 3 | 点「秘制麻辣牛肉串」的 `+` | 弹出辣度层，选「特辣」×2 → 加入 |
| 4 | 再点同款 `+`，选「微微辣」×1 | 购物车里出现两条不同辣度的明细 |
| 5 | 点「土豆片」的 `+`（无规格） | 直接加购，数字跳动 |
| 6 | 底部购物车条「去结算」 | 进入购物车 Tab |
| 7 | 换锅底 / 勾蘸料 / 改数量 / 填备注 | 金额实时变化 |
| 8 | 「去结算」→ 选优惠券 → 提交订单 | 弹出「模拟支付」 |
| 9 | 确认支付 | 跳订单详情，取餐码出现，状态自动推进 |
| 10 | 订单 Tab | 进行中 / 已完成筛选正常 |

**连锁能力体验（需真实后端）**：

| 步骤 | 操作 | 预期 |
| --- | --- | --- |
| 11 | 我的 → 选择门店 | 进入门店列表，按距离由近到远，显示直营/加盟 |
| 12 | 拒绝定位后再次进入 | 提示"开启定位看最近门店"，仍可浏览门店 |
| 13 | 切换到「丰台万达店（加盟）」 | 菜单中该店停售的 2 款菜品消失 |
| 14 | 我的 → 团购券核销 → 输入 `MT16800000001` | 显示"招牌串串双人餐 ¥168"核销成功 |
| 15 | 再次核销同一券码 | 提示已核销，并带出原核销时间与门店 |
| 16 | 管理后台切换主题为「会员日」后重进小程序 | 全页变黑金配色 |

---

## 四、切到真实后端

只改 `utils/config.js`：

```js
module.exports = {
  BASE_URL: 'https://api.your-domain.cn/miniapp/v1',
  USE_MOCK: false,        // 关闭本地数据，走 services → request → 后端
  MOCK_PAY: false,        // 关闭模拟支付，走 wx.requestPayment
  TMPL: {
    ORDER_PAID: '你的下单成功模板ID',
    ORDER_READY: '你的出餐通知模板ID',
  },
};
```

后端已实现的接口（与 `services/` 一一对应，完整清单见 `docs/03-接口文档.md`）：

| 域 | 接口 |
| --- | --- |
| 登录 | `POST /auth/wechat-login` `/auth/refresh` `/auth/logout` |
| 门店 | `GET /stores`（附近门店） `GET /stores/:id` |
| 菜单 | `GET /menu?storeId=` |
| 主题 | `GET /theme?storeId=` |
| 优惠券 | `GET /coupons/center` `POST /coupons/:id/receive` `GET /user/coupons` `POST /coupons/usable` |
| 团购券 | `POST /voucher/verify` `GET /voucher/mine` |
| 订单 | `POST /orders` `GET /orders` `GET /orders/:id` `POST /orders/:id/{cancel,finish,urge,refund,feedback}` |
| 支付 | `POST /orders/:id/prepay` `POST /orders/:id/query-pay` |
| 用户 | `GET/PUT /user/profile` `POST /user/avatar` `POST /user/phone` `GET /user/stats` `GET/POST/DELETE /user/invoice[/:id]` |

> ⚠️ **金额一律服务端裁决**：客户端传的 `amount` 只用于校验，服务端按库内价重算。
> 打包费由 `/menu` 的 `packFee` 下发，优惠券抵扣走 `POST /coupons/usable`——**客户端不得自行计算**，否则会出现"页面显示与实付不一致"。

---

## 五、已知边界

| 项 | 说明 |
| --- | --- |
| Mock 模式 | 无网络请求；订单状态按「支付后经过的秒数」推进（0s 已支付 / 12s 接单 / 40s 涮煮 / 95s 可取餐） |
| 门店/核销/领券 | 依赖真实后端，Mock 模式下不展示（门店列表会走 mock 坐标） |
| 图片 | 用 emoji + 渐变底色，**零图片资源**；接入真实图时把 emoji 换成 `<image mode="aspectFill">` 即可 |
| 分包 | `packageUser` 目前只有优惠券页，可作为「会员中心 / 储值卡 / 地址簿」的容器 |
| 配送 | 不支持，仅堂食与到店自取 |
| 主题令牌 | 与服务端 `themeService.DEFAULT_TOKENS` 保持 15 个键一致；拉不到主题时回落默认令牌，不影响点单 |
