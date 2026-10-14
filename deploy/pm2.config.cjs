/**
 * PM2 进程编排（单机多实例方案）
 * ------------------------------------------------------------
 * 适用：想在**一台机器**上跑多个实例（利用多核）但暂时不引入容器编排。
 *
 * 用法：
 *   npm i -g pm2
 *   pm2 start deploy/pm2.config.cjs --env production
 *   pm2 save && pm2 startup     # 开机自启
 *   pm2 reload lbz-order         # 零停机滚动重启（依赖应用优雅关闭）
 *
 * 注意（集群多机场景）：
 *   · 本文件只在**单台机器**内起多实例；多机请用各自的 systemd + Nginx upstream。
 *   · Redis 必须共享（限流/锁/幂等/缓存），否则多实例之间计数不一致。
 *   · 上传目录必须改对象存储，否则只有写入实例能看到文件。
 */
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'lbz-order',
      script: 'src/index.js',
      cwd: path.resolve(__dirname, '..', 'server'),
      // TODO: 按 CPU 核数调整；生产建议 = 核数，且总内存留 30% 余量
      instances: 2,
      exec_mode: 'cluster',
      env: { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production' },
      // 优雅关闭：与 systemd 的 TimeoutStopSec 保持一致的语义
      kill_timeout: 30000,
      wait_ready: false,
      listen_timeout: 10000,
      // 崩溃自愈
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      min_uptime: '10s',
      // 内存超阈值自动重启（防内存泄漏拖垮机器）
      max_memory_restart: '600M',
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
