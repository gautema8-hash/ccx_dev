# 老北京麻辣串串香 · 连锁点单系统

面向**全国连锁门店（直营 + 加盟）**的点单与运营管理系统。
项目由**四个互相独立的目录**组成，可分别开发、部署与扩展。

---

## 一、目录结构与职责

```
ccx_dev/
│
├── miniprogram/          ① 小程序前端（顾客端）
├── miniprogram-server/   ② 小程序后端（顾客端 API + 数据库 schema + 领域规则）
├── admin-web/            ③ 管理系统前端（运营后台 Web，零构建）
├── admin-server/         ④ 管理系统后端（员工鉴权 + RBAC + 运营 API）
│
├── docs/                 交付文档（需求/架构/接口/运维/交付/使用/审查/测试/执行日志）
├── deploy/               部署配置（Nginx 单节点/集群、systemd、PM2）
├── preview/              离线预览版视图层源码
├── tools/                工具脚本（静态审查/预览构建/端到端）
└── lbz-chuanchuan/       ⚠️ 已废弃（代码已迁至 miniprogram/，见其内 README）
```

## 二、四个目录的职责与关系

### 关系图

```
        微信小程序                    浏览器
            │                          │
            ▼                          ▼
   ┌─────────────────┐        ┌─────────────────┐
   │  ① miniprogram   │        │   ③ admin-web    │
   │  小程序前端       │        │   管理后台前端     │
   └────────┬────────┘        └────────┬────────┘
            │ HTTPS                    │ HTTPS
            │ /miniapp/v1/*            │ /miniapp/v1/admin/*
            ▼                          ▼
   ┌─────────────────┐        ┌─────────────────┐
   │ ② miniprogram-   │◀───────│  ④ admin-server  │
   │    server        │ internal│    管理系统后端    │
   │  小程序后端       │ X-Internal-Token          │
   └────────┬────────┘        └────────┬────────┘
            │                          │
            └──────────┬───────────────┘
                       ▼
              ┌──────────────────┐
              │  MySQL（27 张表）  │  schema 由 ② 拥有
              │  Redis（缓存/锁） │  两服务共享
              └──────────────────┘
```

### 职责划分

| 目录 | 端口 | 前缀 | 职责 |
| --- | --- | --- | --- |
| `miniprogram/` | — | — | 顾客端页面与交互；本地购物车；**不做任何业务裁决** |
| `miniprogram-server/` | 3000 | `/miniapp/v1` | 顾客端 API；**拥有数据库 schema**；**拥有全部领域规则**（状态机/库存/券/核销）；微信登录与支付 |
| `admin-web/` | 静态 | — | 运营后台页面；按权限渲染菜单；令牌管理 |
| `admin-server/` | 3001 | `/miniapp/v1/admin` | 员工账号与 RBAC；门店/员工/菜品/主题/券模板/审计的 CRUD；**领域操作转发给 ②** |

### 为什么领域规则只在 ② 一份

订单状态机、券防超发、团购券防重核销、库存原子扣减——这些规则**复制两份必出分裂**：
「小程序端改了状态机、管理端没改」→ 状态错乱或超卖。
所以 ④ 通过 `internalApi` 调 ② 的 `/internal/*`（`X-Internal-Token` 鉴权，未配置则全部拒绝）。

**④ 直连 DB 的只有纯 CRUD**（门店、员工、菜品、主题、券模板、审计）——这些没有状态机，直接读写不会产生规则分裂。

### 两侧必须保持一致的约定

| 项 | 位置 |
| --- | --- |
| `JWT_SECRET` | 两服务 `.env` 同名同值（令牌 `typ` 不同，互不可用） |
| `INTERNAL_TOKEN` | 两服务 `.env` 同名同值 |
| 菜单种子数据 | `miniprogram/mock/menu.js` ↔ `miniprogram-server/data/menuSeed.js` |
| JWT 算法 | `②src/auth.js` ↔ `④src/auth.js` |

---

## 三、快速启动

```bash
# ② 小程序后端（先启动，它拥有 schema）
cd miniprogram-server
npm install && cp .env.example .env    # 填 DB/Redis/INTERNAL_TOKEN
node src/db.js migrate && node src/db.js seed
node src/index.js                       # :3000

# ④ 管理系统后端
cd admin-server
npm install && cp .env.example .env     # INTERNAL_TOKEN 与②一致
node src/index.js                       # :3001

# ① 小程序：微信开发者工具导入 miniprogram/，改 utils/config.js 的 BASE_URL
# ③ 管理后台：静态部署 admin-web/（本地可用任意静态服务器预览）
```

演示账号（seed 自带，生产必须改密）：

| 账号 | 密码 | 角色 | 可见门店 |
| --- | --- | --- | --- |
| `admin` | `Admin@123456` | 品牌超管 | 全部 5 家 |
| `region_north` | `Region@123456` | 区域经理 | 华北 |
| `mgr_dz` | `Store@123456` | 东直门店长 | 东直门店 |
| `owner_ft` | `Franchise@123456` | 丰台加盟商 | **仅丰台店** |

---

## 四、测试

```bash
# 后端 340 项（双服务联测，需 ② 与 ④ 都已启动）
cd miniprogram-server && npm test

# 小程序静态审查 + 预览回归 41 项（项目根目录）
node tools/audit-miniprogram.js
node tools/build-preview.js && node tools/verify-preview.js
```

| 套件 | 断言数 | 覆盖 |
| --- | --- | --- |
| 接口层 | 113 | 下单/支付/状态机/退款/超时关单/库存回滚/券计数回退/越权 |
| 连锁能力 | 160 | RBAC 与数据隔离 / 定位 / 主题 / 团购券 / 优惠券 |
| 并发 | 26 | 防超卖 / 幂等 / 锁 / 混合负载（P95=168ms 零 5xx） |
| 健壮性 | 47 | 异常输入 / Redis 降级 / 优雅退出 |
| 预览回归 | 41 | 点单主流程业务逻辑 |

---

## 五、部署

支持**单节点**与**多节点集群**，配置见 `deploy/`：

| 模式 | 配置 | 适用 |
| --- | --- | --- |
| 单节点 | `deploy/nginx-single.conf` | 试点 / 单店 |
| 多节点集群 | `deploy/nginx-cluster.conf` | 面向全国用户 |

两个后端均为**无状态**服务，可各自独立水平扩展。集群硬前提：

1. 同一 `JWT_SECRET` 与 `INTERNAL_TOKEN`
2. 共享 Redis 与 MySQL
3. 上传目录改对象存储（多节点必须）
4. 反代带 `X-Forwarded-For`

详见 `docs/04-运维文档.md`。

---

## 六、文档索引

| # | 文档 | 内容 |
| --- | --- | --- |
| 1 | [`docs/01-需求文档.md`](docs/01-需求文档.md) | 功能范围、角色权限、业务流程、非功能需求 |
| 2 | [`docs/02-系统架构文档.md`](docs/02-系统架构文档.md) | 架构、模块、技术栈、数据流、部署拓扑 |
| 3 | [`docs/03-接口文档.md`](docs/03-接口文档.md) | 接口清单、错误码、鉴权方式 |
| 4 | [`docs/04-运维文档.md`](docs/04-运维文档.md) | 部署、配置、监控、日志、备份、故障处理 |
| 5 | [`docs/05-系统交付说明文档.md`](docs/05-系统交付说明文档.md) | 交付物、环境依赖、验收标准 |
| 6 | [`docs/06-管理系统使用说明.md`](docs/06-管理系统使用说明.md) | 管理后台操作指南 |
| 7 | [`docs/07-代码审查报告.md`](docs/07-代码审查报告.md) | 问题清单（级别/位置/修复） |
| 8 | [`docs/08-测试报告与遗留风险.md`](docs/08-测试报告与遗留风险.md) | 用例、结果、遗留风险 |
| 9 | [`docs/09-项目执行日志.md`](docs/09-项目执行日志.md) | 全程需求、决策与执行记录 |
| 10 | [`docs/10-真机与交付测试报告.md`](docs/10-真机与交付测试报告.md) | 真机验证与交付测试结果 |
| 11 | [`docs/11-我的模块新增功能设计与实现.md`](docs/11-我的模块新增功能设计与实现.md) | 「我的」8 项新增功能：入口分组、路由与跳转、字段定义、接口清单与 mock |

子模块说明：`miniprogram/README.md`、`miniprogram-server/README.md`、`admin-web/README.md`、`admin-server/README.md`、`preview/README.md`、`tools/README.md`、`deploy/README.md`。

---

## 七、上线前必做

| # | 项 |
| --- | --- |
| 1 | `NODE_ENV=production`（缺关键配置拒绝启动） |
| 2 | 两服务 `JWT_SECRET` 换 ≥32 位随机串且**一致** |
| 3 | `INTERNAL_TOKEN` 设置强随机值且**一致**（为空则管理端领域功能不可用） |
| 4 | 微信登录/支付改 `real` 并配齐凭据 |
| 5 | 演示账号改密；生产另行建号 |
| 6 | 全站 HTTPS；`/internal/*` 仅内网可达 |
| 7 | 多节点：上传目录改对象存储、Redis 共享、反代带 `X-Forwarded-For` |

完整清单见 `docs/04-运维文档.md` 第 9 节。
