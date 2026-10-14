-- ============================================================
-- cleanup_legacy.sql —— 清理第一版遗留表 mp_shop
--
-- 背景: mp_shop 是第一版「单店模式」的店铺表，已被连锁版的 mp_store 取代。
--       经核查：代码中零引用（仅 db.js 注释提及）、仅 1 行旧种子数据。
--       该行数据已备份到同目录 mp_shop_backup.sql。
--
-- 用法: mysql -h 127.0.0.1 -P 3306 -uroot -p lbz_order < db/legacy/cleanup_legacy.sql
-- 恢复: mysql ... < db/legacy/mp_shop_backup.sql（需先重建表，见 schema 历史或备份表结构）
-- ============================================================
USE `lbz_order`;

DROP TABLE IF EXISTS `mp_shop`;
