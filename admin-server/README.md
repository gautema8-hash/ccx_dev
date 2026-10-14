# admin-server/ · 管理系统后端（运营 API）

Node.js 服务，与 `miniprogram-server` 同一套自研内核（http/db/redis/logger/errors 各自持有），
面向管理后台前端（`admin-web`），负责**账号权限与运营 CRUD**。

## 职责边界

| 负责（直连 DB 的纯 CRUD） | 不负责（转发给 miniprogram-server 的领域规则） |
| --- | --- |
| 员工账号与 scrypt 口令 | 订单状态机（流转/拒单/退款） |
| RBAC 权限点与门店范围 | 团购券核销与撤销（防重） |
| 门店 / 菜品（品牌级）/ 主题 / 券模板 | 定向发券（防超发与限领） |
| 审计日志与登录日志 | 门店库存与上下架（回滚与缓存失效） |
| 经营统计与看板 | 订单列表/详情 DTO（展示口径） |

**为什么领域操作要转发**：状态机、防超发、防重核销这些规则**只能有一份**。
如果管理端自己再实现一遍，迟早出现「小程序端改了、管理端没改」的分裂，最终状态错乱或超卖。

## 鉴权链路（每个接口必须走完）

```
requireStaff  →  assertPerm（权限点）  →  assertStore（门店范围）  →  audit（留痕）
```

- 门店范围校验**独立于权限点**：区域经理有 `theme:write` 也只能管自己大区的门店。
- 隔离发生在 SQL 层（`rbac.applyScope` 产出 `AND store_id IN (...)`），兜底是「查不到」而非「泄露」。
- 令牌 `typ:'staff'`，与小程序用户令牌（`uid/openid`）**互不可用**。

## 目录结构

```
admin-server/
├── package.json            # 仅 mysql2 + ioredis
├── .env / .env.example
├── src/
│   ├── index.js            # 入口（不建表：schema 属于 miniprogram-server）
│   ├── app.js              # 路由装配（/miniapp/v1/admin/*）
│   ├── http.js / config.js / redis.js / logger.js / errors.js
│   ├── db.js               # 精简版：只有连接池与事务，无 migrate/seed
│   ├── auth.js             # 精简版 JWT（仅 sign/verify/extractToken，无用户体系）
│   ├── staffAuth.js        # scrypt 口令、锁定、强制改密、审计
│   ├── rbac.js             # 权限点、角色、门店范围、SQL 片段
│   ├── internalApi.js      # ★ 调用 miniprogram-server 的 /internal/*
│   ├── voucherQuery.js     # 核销记录查询（管理端专用，带范围过滤与面值合计）
│   ├── themeService.js / couponService.js
│   └── routes/admin.js     # 40+ 管理接口
└── test/                   # 空：联测脚本统一放在 miniprogram-server/test
```

## 快速开始

```bash
# 前置：miniprogram-server 已完成 migrate + seed（员工账号在它的种子里）
npm install
cp .env.example .env        # 填 DB / Redis / INTERNAL_TOKEN（与 miniprogram-server 一致）
node src/index.js           # http://127.0.0.1:3001
```

演示账号（来自 miniprogram-server 的 seed）：

| 账号 | 密码 | 角色 |
| --- | --- | --- |
| `admin` | `Admin@123456` | 品牌超管 |
| `region_north` | `Region@123456` | 区域经理 |
| `mgr_dz` | `Store@123456` | 东直门店长 |
| `staff_dz` | `Staff@123456` | 店员 |
| `owner_ft` | `Franchise@123456` | 丰台加盟商 |

## 环境变量（本服务特有）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 监听端口 |
| `API_PREFIX` | `/miniapp/v1/admin` | 接口前缀（**与小程序后端不同**） |
| `MINIPROGRAM_SERVER_URL` | `http://127.0.0.1:3000` | 下游服务地址 |
| `INTERNAL_TOKEN` | 空 | 必须与 miniprogram-server 的一致；为空时领域接口全部不可用（启动时会 warn） |
| `INTERNAL_TIMEOUT_MS` | `8000` | 下游调用超时 |

## 健康与探针

| 端点 | 说明 |
| --- | --- |
| `GET /health` | 存活 |
| `GET /ready` | 就绪（DB 不可用返回 503；Redis 不可用标记 degraded） |
| `GET /metrics` | 指标 |

## ⚠️ 同步约定（改代码必读）

| 文件 | 与谁同步 |
| --- | --- |
| `src/auth.js` 的 JWT 算法与密钥 | `miniprogram-server/src/auth.js`（同一 `JWT_SECRET` 配置） |
| `.env` 的 `INTERNAL_TOKEN` | `miniprogram-server/.env` |
