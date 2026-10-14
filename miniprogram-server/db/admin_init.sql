-- ============================================================
-- 老北京麻辣串串香 · 连锁点单系统
-- admin_init.sql —— 超级管理员与品牌基础数据初始化
--
-- 项目: miniprogram-server（数据库 schema 的唯一拥有者）
-- 前置: 已执行 schema.sql（建表）或 node src/db.js migrate
--
-- 口令说明:
--   密码散列使用 scrypt（keylen 64）+ 固定盐（salt 见下），
--   与 admin-server/src/staffAuth.js 的 hashPassword 参数完全一致，
--   因此本脚本写入的账号口令为  Admin@123456 ，可直接登录管理后台。
--   ⚠️ 生产环境首次登录后必须改密（系统也会强制 must_change_pwd=1 的账号改密，
--      本演示账号 must_change_pwd=0，便于本地直接用；生产请另行建号并置 1）。
--
-- 可重复执行：全部使用 INSERT ... ON DUPLICATE KEY UPDATE，幂等。
-- ============================================================

USE `lbz_order`;
SET NAMES utf8mb4;

-- ------------------------------------------------------
-- 1) 品牌（必需：员工 / 门店 / 券 / 主题均以 brand_id 归属）
-- ------------------------------------------------------
INSERT INTO `mp_brand` (`id`, `name`, `logo`, `notice`, `contact`, `status`, `created_at`, `updated_at`)
VALUES
  ('brand_lbz', '老北京麻辣烫串串香（集团）', '🌶️', '现串现涮 · 每日 11:00 开锅 · 全国连锁', '400-888-6666', 1, UNIX_TIMESTAMP() * 1000, UNIX_TIMESTAMP() * 1000)
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `notice` = VALUES(`notice`),
  `contact` = VALUES(`contact`),
  `updated_at` = VALUES(`updated_at`);

-- ------------------------------------------------------
-- 2) 超级管理员（品牌超管，可见全部门店、全部权限点）
--    account: admin    password: Admin@123456
-- ------------------------------------------------------
INSERT INTO `mp_staff` (
  `account`, `password_hash`, `password_salt`, `name`, `phone`, `role`,
  `brand_id`, `region`, `all_stores`, `status`, `must_change_pwd`,
  `fail_count`, `locked_until`, `last_login_at`, `created_at`, `updated_at`
)
VALUES (
  'admin',
  '0943a1987bcb066477d286455d4dbd2d4c310fcebe57edd44da0139e2f5b0d48a5af36a9523ac8a63d694a2b97fa9683e893b993f241b3728f3607d4f6eae13a',
  'a1b2c3d4e5f60708090a0b0c0d0e0f00',
  '品牌管理员', '13800000000', 'BRAND_ADMIN',
  'brand_lbz', '', 1, 1, 0,
  0, 0, 0, UNIX_TIMESTAMP() * 1000, UNIX_TIMESTAMP() * 1000
)
ON DUPLICATE KEY UPDATE
  `password_hash` = VALUES(`password_hash`),
  `password_salt` = VALUES(`password_salt`),
  `role` = VALUES(`role`),
  `all_stores` = VALUES(`all_stores`),
  `status` = VALUES(`status`),
  `updated_at` = VALUES(`updated_at`);

-- ------------------------------------------------------
-- 3) 说明：超管的门店范围
--    BRAND_ADMIN 的 all_stores=1，无需在 mp_staff_store 里逐店授权。
--    若需给非超管账号授权门店，参考：
--      INSERT INTO `mp_staff_store` (`staff_id`, `store_id`, `created_at`)
--      VALUES (<staff_id>, 'st_dz', UNIX_TIMESTAMP() * 1000);
--
-- 4) 完整演示数据（5 门店 / 30 菜品 / 6 员工 / 4 主题 / 5 券模板）
--    不建议用 SQL 手写——量太大且需与代码常量一致。
--    请改用代码种子：node src/db.js seed（与本脚本可叠加，均为幂等）。
-- ============================================================
