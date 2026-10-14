# miniprogram-server/ · 小程序后端（顾客端 API）

Node.js 服务，**零 Web 框架**（自研 `http.js`，仅 `mysql2` + `ioredis` 两个依赖）。
面向小程序顾客端，同时**拥有数据库 schema 与全部领域规则**。

## 职责边界（四个目录中最核心的一个）

| 拥有 | 说明 |
| --- | --- |
| **数据库 schema** | `src/db.js` 的 `migrate` / `seed` / 平滑加列都在这里，admin-server 不建表 |
| **订单状态机** | `src/routes/flow.js`：接单/制作/出餐/完成/拒单/退款，全系统只有这一份 |
| **库存原子扣减与回滚** | `UPDATE ... WHERE stock >= ?`，含超时未支付自动关单回滚 |
| **券抵扣口径** | `src/couponService.js` 的 `calcDiscount()`，展示与下单同源 |
| **团购券防重核销** | `src/voucherService.js`，DB 唯一键兜底 |
| **超时关单** | prepay 触发 + 订单查询惰性清理 + 60s 定时兜底 |
| 微信登录与支付 | `src/wechat.js`（code2session / 支付 v3 签名验签解密） |

**对外**：`/miniapp/v1/*`（小程序顾客端）+ `/internal/*`（仅 admin-server，令牌鉴权）。

## 与 admin-server 的契约

```
admin-server ──internalApi──▶ miniprogram-server /internal/*
   订单推进 / 拒单 / 退款审核        （状态机只有一份）
   团购券核销 / 撤销                （防重规则只有一份）
   定向发券                         （防超发与限领只有一份）
   门店库存与上下架                  （扣减回滚与缓存失效只有一份）
   订单列表/详情 DTO                 （展示口径只有一份）
```

**鉴权**：请求头 `X-Internal-Token`，与 `.env` 的 `INTERNAL_TOKEN` 一致；
未配置时 `/internal/*` **全部拒绝**（宁拒勿裸奔）。生产建议仅监听内网。

## 目录结构

```
miniprogram-server/
├── package.json            # 仅 mysql2 + ioredis
├── .env / .env.example
├── data/
│   └── menuSeed.js         # 菜单种子数据（与 miniprogram/mock/menu.js 同步维护）
├── src/
│   ├── index.js            # 入口：启动校验、超时关单定时器、优雅关闭
│   ├── app.js              # 路由装配（顾客端 + internal）
│   ├── http.js             # 自研 HTTP 内核（路由/限流/过载保护/安全头）
│   ├── config.js / db.js / redis.js / logger.js / errors.js
│   ├── auth.js             # 用户 JWT（与 admin-server 的 staff JWT 用同一密钥、不同 typ）
│   ├── wechat.js / geo.js
│   ├── themeService.js / couponService.js
│   ├── voucherService.js + voucherProvider.js
│   └── routes/
│       ├── menu.js chain.js order.js pay.js user.js   # 顾客端 API
│       ├── flow.js         # ★ 订单流转规则（管理端经 internal 调用）
│       └── internal.js     # ★ 内部接口（仅 admin-server）
└── test/                   # 4 套黑盒测试（双服务联测，见下）
```

## 快速开始

```bash
npm install
cp .env.example .env        # 填 DB / Redis / INTERNAL_TOKEN
node src/db.js migrate      # 建 27 张表（幂等）
node src/db.js seed         # 种子：1 品牌 / 5 门店 / 30 菜品 / 6 员工 / 4 主题 / 5 券模板
node src/index.js           # http://127.0.0.1:3000
```

> seed 的员工账号口令用 `hashPasswordForSeed()`（scrypt 参数与 admin-server 的 staffAuth 完全一致），
> 否则 seed 出的账号登不进管理端。

## 测试（四套，双服务联测）

```bash
# 前置：本服务(3000)与 admin-server(3001) 都已启动
API_BASE=http://127.0.0.1:3000/miniapp/v1 \
ADMIN_API_BASE=http://127.0.0.1:3001/miniapp/v1/admin \
npm test                    # api 107 → chain 160 → concurrency 26 → resilience 47 = 340 项
```

测试脚本的 `call()` 会按路径自动路由：`/admin/*` → admin-server，其余 → 本服务。

## 环境变量（新增项）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `INTERNAL_TOKEN` | 空 | admin-server 调用 `/internal/*` 的令牌；**未配置则内部接口全部拒绝** |

其余配置见 `.env.example` 与 `docs/04-运维文档.md`。
