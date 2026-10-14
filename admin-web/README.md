# admin-web/ · 管理系统前端（运营后台 Web）

原生 JS 单页应用，**零构建**（无 webpack/vite、无框架）。三个文件直接部署到任意静态服务器即可。

## 职责边界

| 负责 | 不负责 |
| --- | --- |
| 登录页与各运营视图的渲染 | 任何数据校验（后端是唯一裁决方） |
| 令牌存储与 401 自动刷新重放 | 权限判定（菜单只是"不显示"，接口侧才是裁决） |
| 按权限点渲染侧边菜单 | — |

## 文件

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `index.html` | ~0.4 KB | 骨架（内容全部由 JS 渲染） |
| `styles.css` | ~6 KB | 样式 |
| `app.js` | ~55 KB | 全部视图与交互逻辑 |

## 后端地址配置

`app.js` 顶部：

```js
var API = (window.__ADMIN_API_BASE__ || '/miniapp/v1/admin');
```

| 部署方式 | 做法 |
| --- | --- |
| **同源反代（推荐）** | Nginx 把 `/miniapp/v1/admin` 反代到 admin-server(3001)，前端走默认相对路径 |
| **前后端分域** | 在 `index.html` 的 `<head>` 里加 `<script>window.__ADMIN_API_BASE__='https://admin-api.xxx.com/miniapp/v1/admin'</script>` |

## 本地预览（三种方式）

```bash
# 方式 A：直接双击 index.html（file:// 协议下 fetch 同源接口会失败，仅看 UI 结构）

# 方式 B：任意静态服务器（推荐配合本地 admin-server）
npx serve admin-web           # 或 python -m http.server -d admin-web 8080

# 方式 C：由 Nginx 统一代理（见 deploy/）
```

> 方式 B 下需要设置 `window.__ADMIN_API_BASE__ = 'http://127.0.0.1:3001/miniapp/v1/admin'`
> 才能连到本地 admin-server（跨域需 admin-server 侧放行，生产建议一律同源反代）。

## 登录

访问页面 → 输入账号密码（演示账号见 `admin-server/README.md`）。
首登强制改密；令牌 2 小时自动续期。

## 功能视图（按权限显示）

| 菜单 | 权限点 | 功能 |
| --- | --- | --- |
| 📊 经营看板 | `stats:read` | 今日订单/营业额/待处理 |
| 🧾 订单管理 | `order:read` | 列表筛选、接单/制作/出餐/完成、拒单（已付自动退款） |
| 🎫 团购券核销 | `voucher:verify` | 店员代客核销、记录查询、撤销 |
| 🎟️ 优惠券 | `coupon:read` | 模板 CRUD、定向发放、统计 |
| 🎨 主题管理 | `theme:read` | 预置模板一键套用、自定义令牌、时间窗 |
| 🍢 菜单与库存 | `dish:read` | 门店库存/改价/停售（总部维护菜品） |
| 🏪 门店管理 | `store:read` | 直营/加盟门店 CRUD |
| 👥 员工与权限 | `staff:read` | 账号、角色、门店授权 |
| 📜 审计日志 | `audit:read` | 操作留痕与登录日志 |

## 安全特性（内置）

| 特性 | 说明 |
| --- | --- |
| 全量 `esc()` 转义 | 所有动态插值防 XSS |
| 令牌存 localStorage | ⚠️ 已知取舍，建议生产改 httpOnly Cookie（见 docs/07 R-A1） |
| 401 刷新只重放一次 | `__retried` 防无限递归 |
| 请求 15s 超时 | `AbortSignal.timeout` |
| 会话失效自动登出 | 业务码 `40100/40300` 判定 |

## 已知限制

| 项 | 说明 |
| --- | --- |
| 无构建/无单测 | 迭代维护成本较高，见 docs/07 R-A2 |
| 令牌在 localStorage | XSS 可读，依赖 CSP + 转义缓解 |
| 门店改价无界面入口 | 当前走 `POST /admin/store-dishes` 接口（docs/06 T-01） |
