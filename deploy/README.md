# 部署配置

本目录提供单节点与多节点（集群）两种部署模式的参考配置。**完整操作步骤见 `docs/04-运维文档.md`**。

## 文件

| 文件 | 用途 |
| --- | --- |
| `nginx-single.conf` | 单节点：Nginx 反向代理 + TLS + 安全头 |
| `nginx-cluster.conf` | 多节点：Nginx 负载均衡（least_conn）+ 入口限流 + 故障摘除 |
| `lbz-order.service` | systemd 单元（每台应用节点都用） |
| `pm2.config.cjs` | 单机多实例编排（可选，用于在一台机器上利用多核） |

## 选择哪种模式

| 场景 | 用哪个 |
| --- | --- |
| 试点 / 单店 / 小规模 | `nginx-single.conf` + `lbz-order.service` |
| 面向全国用户 | `nginx-cluster.conf` + `lbz-order.service`（每台节点）+ 共享 Redis + 对象存储 |
| 单机想跑多核 | `pm2.config.cjs`（仍需 Redis 共享语义） |

## 多节点的前置条件（缺一会导致隐蔽故障）

| # | 条件 | 不满足的后果 |
| --- | --- | --- |
| 1 | 所有实例用同一个 `JWT_SECRET` | 令牌在部分实例校验失败，随机掉登录 |
| 2 | 所有实例连同一个 Redis | 限流/锁/幂等计数不一致，可能超卖或重复扣款 |
| 3 | 上传目录已改对象存储 | 头像/票据在部分实例 404 |
| 4 | 反向代理带 `X-Forwarded-For` | 全国用户被算成同一个 IP，限流误伤全站 |

## 使用

```bash
# 单节点
sudo cp deploy/nginx-single.conf /etc/nginx/conf.d/lbz.conf
# 集群
sudo cp deploy/nginx-cluster.conf /etc/nginx/conf.d/lbz.conf
#   → 编辑 upstream 块，填入真实内网 IP

sudo nginx -t && sudo systemctl reload nginx

# 进程托管（每台应用节点）
sudo cp deploy/lbz-order.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lbz-order
```

> 配置里的域名、证书路径、内网 IP、运行用户均为占位值，需按实际环境替换（已在文件中用 `TODO` 标注）。
