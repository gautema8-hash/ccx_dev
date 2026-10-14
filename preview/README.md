# 预览版（离线单文件演示）

`../老北京麻辣串串香-点单小程序预览.html` 的**视图层源码**。

## 它是什么

一个**不依赖微信开发者工具、不依赖后端**的单文件 HTML，双击即可在浏览器里走完点单主流程。用于：

- 给不懂小程序的人演示（客户、运营、评审）
- 在没有开发者工具的机器上快速验证业务逻辑
- 作为回归测试的可执行载体（`tools/verify-preview.js`，41 项断言）

## 关键设计：不重写业务逻辑

预览版**不重新实现**点单逻辑，而是把小程序源码原样内联 + 提供浏览器侧运行时桩：

| 层 | 做法 |
| --- | --- |
| 业务代码 | 直接内联 `mock/menu.js` `utils/{config,util,request,auth,cart}.js` `services/{menu,order}.js` 等 9 个模块 |
| 模块系统 | 极简 CommonJS 加载器，支持 `./` 与 `../` 相对路径解析 |
| `wx` 桩 | Storage → localStorage（前缀 `lbzpv:`）；`showToast/showModal/showLoading` → `window.__UI`；`wx.login` 返回假 code |
| 视图层 | WXML/WXSS 转写为 HTML/CSS（`template.html` / `preview.css` / `preview.js`） |

**收益**：改了小程序源码，重跑构建脚本即可同步；不存在两套逻辑漂移。

## 文件

| 文件 | 说明 |
| --- | --- |
| `template.html` | 页面骨架（HTML 版 WXML） |
| `preview.css` | 样式（33.8 KB） |
| `preview.js` | 视图层逻辑与 Actions（55.2 KB） |

## 构建与验证

```bash
# 在**项目根目录**执行
node tools/build-preview.js     # 生成 ../老北京麻辣串串香-点单小程序预览.html
node tools/verify-preview.js    # 41 项断言回归
```

`build-preview.js` 会在**构建产物里**把 `USE_MOCK` 强制改回 `true`，源码不受影响。

## 已知边界

| 项 | 说明 |
| --- | --- |
| 覆盖范围 | 仅点单主流程（菜单 → 购物车 → 结算 → 订单）；**不含**门店列表、团购券核销、领券中心（这些依赖后端） |
| 支付 | 模拟收银台，无真实支付 |
| 定位 | 不调用 `wx.getLocation`，门店距离为 mock 值 |
| 主题 | 使用默认令牌（无服务端主题） |

> 覆盖门店/核销/领券需在预览版补充 `services/chain.js` 的 mock 实现——见 `docs/07-代码审查报告.md` MP-11。
