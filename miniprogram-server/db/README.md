# db/ —— 数据库与 Redis 初始化脚本（miniprogram-server）

> 数据库 schema 的唯一拥有者是 `miniprogram-server`（见 `../README.md` 的「职责边界」）。
> 因此初始化脚本**只放在这里**，`admin-server` 不建表、不持有任何 SQL 脚本——它只读/写已有的库。

## 文件清单

| 文件 | 用途 |
| --- | --- |
| `schema.sql` | 27 张 `mp_*` 表的 DDL 建表语句（由本机 MySQL 8.0.44 的 `lbz_order` 库 `mysqldump --no-data` 导出，与 `src/db.js` 的 migrate 一致） |
| `admin_init.sql` | 品牌 + 超级管理员（`admin / Admin@123456`）基础数据初始化，幂等可重复执行 |
| `init.sql` | 前两者合并的一键初始化脚本 |
| `redis-init.js` | Redis 验证与维护脚本（本项目 Redis 无前置数据，仅缓存/限流/锁/黑名单） |

## 关系型数据库（MySQL 8.0.44）

本机实例：`127.0.0.1:3306`，库名 `lbz_order`（账号见 `.env`，默认 root）。

### 一键初始化

```bash
# 方式 A：用合并脚本（等价于 B，幂等）
mysql -h 127.0.0.1 -P 3306 -uroot -p < db/init.sql

# 方式 B：分开执行
mysql -h 127.0.0.1 -P 3306 -uroot -p < db/schema.sql
mysql -h 127.0.0.1 -P 3306 -uroot -p < db/admin_init.sql

# 方式 C（推荐，与代码单一事实来源一致，含完整演示数据）
cd miniprogram-server
node src/db.js migrate     # 等价于 schema.sql
node src/db.js seed        # 等价于 admin_init.sql + 5 门店/30 菜品/6 员工/4 主题/5 券模板
```

### 脚本说明

- `schema.sql` **只含建表**，不含基础数据；**不含**旧遗留表 `mp_shop`（已被 `mp_store` 取代）。
- `admin_init.sql` 只写品牌与超管；完整演示数据量大且需与代码常量一致，请用 `node src/db.js seed`。
- 全部脚本**幂等**：DDL 用 `CREATE TABLE IF NOT EXISTS`（导出的 mysqldump 用 `DROP TABLE IF EXISTS` 后重建，
  执行前会清空该表；若只想建表不覆盖，请用 `src/db.js migrate`），基础数据用 `INSERT ... ON DUPLICATE KEY UPDATE`。
- 超管口令散列为 **scrypt(keylen 64)+固定盐**，与 `admin-server/src/staffAuth.js` 参数完全一致，
  因此 `admin_init.sql` 写出的账号密码就是 `Admin@123456`。

## Redis（5.0.14.1）

本机实例：`127.0.0.1:6379`，无密码，`db=0`，keyPrefix=`lbz:`。

本项目 Redis **没有任何必须预置的数据**（缓存/限流/锁/黑名单都是运行时动态产生），
因此"初始化"= 验证可达 + 可选清空本项目命名空间：

```bash
cd miniprogram-server
node db/redis-init.js             # 只读：验证连接 + 统计 lbz:* 键
node db/redis-init.js --flush     # 清空 lbz:*（危险，需输入 YES 二次确认）
```

键前缀约定：

| 前缀 | 用途 | 来源 |
| --- | --- | --- |
| `lbz:c:*` | 缓存（菜单/主题/用户） | `src/redis.js` cache |
| `lbz:r:*` | 限流计数 | `src/redis.js` rateLimit |
| `lbz:l:*` | 分布式锁 | `src/redis.js` lock |
| `lbz:bl:*` | 令牌 jti 黑名单 | `src/auth.js` |

> 幂等键**不在 Redis**，在 MySQL 的 `mp_idempotency` 表（DB 唯一键兜底，Redis 掉线也生效）。

## 环境变量

脚本从 `../.env` 或进程环境读取：`DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`、
`REDIS_HOST/REDIS_PORT/REDIS_PASSWORD/REDIS_KEY_PREFIX`。默认值见 `src/config.js`。
