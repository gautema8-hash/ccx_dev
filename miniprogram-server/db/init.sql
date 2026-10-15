-- ============================================================
-- 老北京麻辣串串香 · 连锁点单系统
-- init.sql —— 一键初始化（schema.sql + admin_init.sql 合并）
--
-- 用法（本机 MySQL 8.0.44）:
--   mysql -h 127.0.0.1 -P 3306 -uroot -p < db/init.sql
-- 或分开执行（等价）:
--   mysql ... < db/schema.sql && mysql ... < db/admin_init.sql
--
-- 说明:
--   1) 脚本可重复执行（DDL 幂等，基础数据用 ON DUPLICATE KEY UPDATE）
--   2) 超管账号: admin / Admin@123456（scrypt 散列，与 staffAuth 参数一致）
--   3) 完整演示数据请改用代码种子: node src/db.js seed（与本脚本可叠加）
-- ============================================================

-- ===== [1/2] schema.sql =====
-- ============================================================
-- ============================================================
-- 老北京麻辣串串香 · 连锁点单系统
-- schema.sql —— 数据库结构定义（34 张 mp_* 表，DDL 建表语句）
--
-- 项目: miniprogram-server（数据库 schema 的唯一拥有者）
-- 来源: 由本机 MySQL 8.0.44 的 lbz_order 库以 mysqldump --no-data 导出，
--       与 miniprogram-server/src/db.js 的 migrate 逻辑一致
-- 说明: 不含旧遗留表 mp_shop（已被 mp_store 取代，属冗余残留，见 docs/10）
--
-- 使用: 本文件只含建表语句，不含基础数据。基础数据见 admin_init.sql。
--       或直接运行: node src/db.js migrate（与下方 DDL 等价且幂等）
-- ============================================================

-- 若需从零建库，取消下行注释
-- CREATE DATABASE IF NOT EXISTS `lbz_order` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE `lbz_order`;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- MySQL dump 10.13  Distrib 8.0.44, for Win64 (x86_64)
--
-- Host: 127.0.0.1    Database: lbz_order
-- ------------------------------------------------------
-- Server version	8.0.44


--
-- Table structure for table `mp_audit_log`
--

DROP TABLE IF EXISTS `mp_audit_log`;
CREATE TABLE `mp_audit_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `brand_id` varchar(32) NOT NULL DEFAULT '',
  `store_id` varchar(32) NOT NULL DEFAULT '',
  `staff_id` bigint NOT NULL DEFAULT '0',
  `staff_name` varchar(64) NOT NULL DEFAULT '',
  `role` varchar(32) NOT NULL DEFAULT '',
  `action` varchar(64) NOT NULL,
  `target` varchar(64) NOT NULL DEFAULT '',
  `detail` varchar(1024) NOT NULL DEFAULT '',
  `ip` varchar(64) NOT NULL DEFAULT '',
  `ua` varchar(255) NOT NULL DEFAULT '',
  `request_id` varchar(64) NOT NULL DEFAULT '',
  `created_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_brand_time` (`brand_id`,`created_at`),
  KEY `idx_staff` (`staff_id`,`created_at`),
  KEY `idx_action` (`action`,`created_at`)
) ENGINE=InnoDB AUTO_INCREMENT=361 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_brand`
--

DROP TABLE IF EXISTS `mp_brand`;
CREATE TABLE `mp_brand` (
  `id` varchar(32) NOT NULL,
  `name` varchar(128) NOT NULL,
  `logo` varchar(32) NOT NULL DEFAULT 0xF09F8CB6EFB88F,
  `notice` varchar(255) NOT NULL DEFAULT '',
  `contact` varchar(64) NOT NULL DEFAULT '',
  `status` tinyint NOT NULL DEFAULT '1',
  `created_at` bigint NOT NULL,
  `updated_at` bigint NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_category`
--

DROP TABLE IF EXISTS `mp_category`;
CREATE TABLE `mp_category` (
  `id` varchar(32) NOT NULL,
  `brand_id` varchar(32) NOT NULL,
  `name` varchar(64) NOT NULL,
  `emoji` varchar(8) NOT NULL DEFAULT '',
  `sort` int NOT NULL DEFAULT '0',
  `status` tinyint NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  KEY `idx_brand_sort` (`brand_id`,`status`,`sort`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_coupon`
--

DROP TABLE IF EXISTS `mp_coupon`;
CREATE TABLE `mp_coupon` (
  `id` varchar(32) NOT NULL,
  `brand_id` varchar(32) NOT NULL DEFAULT 'brand_lbz',
  `name` varchar(64) NOT NULL,
  `type` varchar(16) NOT NULL COMMENT 'CASH 现金券|SOUP 锅底券|DISCOUNT 折扣券',
  `value` int NOT NULL COMMENT '现金券=分；折扣券=折扣百分比(如 88 表示 8.8 折)',
  `threshold` int NOT NULL DEFAULT '0' COMMENT '门槛（分），0=无门槛',
  `scope` varchar(128) NOT NULL DEFAULT '',
  `store_ids` varchar(512) NOT NULL DEFAULT '' COMMENT '空=全品牌通用；否则为 JSON 门店数组',
  `issue_type` varchar(16) NOT NULL DEFAULT 'MANUAL' COMMENT 'NEW_USER|CAMPAIGN|MANUAL|RECEIVE',
  `receive_enabled` tinyint NOT NULL DEFAULT '0' COMMENT '1=出现在小程序领券中心',
  `receive_start` bigint NOT NULL DEFAULT '0',
  `receive_end` bigint NOT NULL DEFAULT '0',
  `day_limit` int NOT NULL DEFAULT '0' COMMENT '每人每日限领，0=不限',
  `total` int NOT NULL DEFAULT '999999',
  `issued` int NOT NULL DEFAULT '0',
  `per_user` int NOT NULL DEFAULT '1',
  `used_count` int NOT NULL DEFAULT '0',
  `expire_at` varchar(16) NOT NULL DEFAULT '',
  `status` tinyint NOT NULL DEFAULT '1',
  `created_by` bigint NOT NULL DEFAULT '0',
  `created_at` bigint NOT NULL DEFAULT '0',
  `updated_at` bigint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_status` (`status`),
  KEY `idx_brand` (`brand_id`,`status`),
  KEY `idx_receive` (`receive_enabled`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_coupon_receive`
--

DROP TABLE IF EXISTS `mp_coupon_receive`;
CREATE TABLE `mp_coupon_receive` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL,
  `coupon_id` varchar(32) NOT NULL,
  `store_id` varchar(32) NOT NULL DEFAULT '',
  `source` varchar(16) NOT NULL DEFAULT 'RECEIVE' COMMENT 'RECEIVE|NEW_USER|MANUAL|CAMPAIGN',
  `operator` bigint NOT NULL DEFAULT '0',
  `created_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`,`created_at`),
  KEY `idx_coupon` (`coupon_id`,`created_at`)
) ENGINE=InnoDB AUTO_INCREMENT=1492 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_dip`
--

DROP TABLE IF EXISTS `mp_dip`;
CREATE TABLE `mp_dip` (
  `id` varchar(32) NOT NULL,
  `brand_id` varchar(32) NOT NULL,
  `name` varchar(64) NOT NULL,
  `price` int NOT NULL DEFAULT '0',
  `emoji` varchar(8) NOT NULL DEFAULT '',
  `sort` int NOT NULL DEFAULT '0',
  `status` tinyint NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  KEY `idx_brand` (`brand_id`,`status`,`sort`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_dish`
--

DROP TABLE IF EXISTS `mp_dish`;
CREATE TABLE `mp_dish` (
  `id` varchar(32) NOT NULL,
  `brand_id` varchar(32) NOT NULL,
  `category_id` varchar(32) NOT NULL,
  `name` varchar(128) NOT NULL,
  `description` varchar(255) NOT NULL DEFAULT '',
  `emoji` varchar(8) NOT NULL DEFAULT '',
  `image` varchar(255) NOT NULL DEFAULT '',
  `price` int NOT NULL COMMENT '指导价，单位：分',
  `unit` varchar(16) NOT NULL DEFAULT '份',
  `spicy` tinyint NOT NULL DEFAULT '0',
  `tags` varchar(255) NOT NULL DEFAULT '[]',
  `status` tinyint NOT NULL DEFAULT '1' COMMENT '总部上下架',
  `sort` int NOT NULL DEFAULT '0',
  `updated_at` bigint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_cat` (`category_id`,`status`,`sort`),
  KEY `idx_brand` (`brand_id`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_feedback`
--

DROP TABLE IF EXISTS `mp_feedback`;
CREATE TABLE `mp_feedback` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `order_id` varchar(40) NOT NULL,
  `user_id` bigint NOT NULL,
  `score` tinyint NOT NULL DEFAULT '5',
  `content` varchar(500) NOT NULL DEFAULT '',
  `created_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order` (`order_id`)
) ENGINE=InnoDB AUTO_INCREMENT=14 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_idempotency`
--

DROP TABLE IF EXISTS `mp_idempotency`;
CREATE TABLE `mp_idempotency` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL,
  `idem_key` varchar(80) NOT NULL,
  `response` text,
  `created_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_key` (`user_id`,`idem_key`)
) ENGINE=InnoDB AUTO_INCREMENT=39 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_invoice`
--

DROP TABLE IF EXISTS `mp_invoice`;
CREATE TABLE `mp_invoice` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL,
  `title_type` varchar(16) NOT NULL DEFAULT 'personal',
  `title` varchar(128) NOT NULL,
  `tax_no` varchar(64) NOT NULL DEFAULT '',
  `email` varchar(128) NOT NULL DEFAULT '',
  `is_default` tinyint NOT NULL DEFAULT '0',
  `created_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`)
) ENGINE=InnoDB AUTO_INCREMENT=18 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_login_log`
--

DROP TABLE IF EXISTS `mp_login_log`;
CREATE TABLE `mp_login_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `brand_id` varchar(32) NOT NULL DEFAULT '',
  `account` varchar(64) NOT NULL DEFAULT '',
  `staff_id` bigint NOT NULL DEFAULT '0',
  `ip` varchar(64) NOT NULL DEFAULT '',
  `ua` varchar(255) NOT NULL DEFAULT '',
  `success` tinyint NOT NULL DEFAULT '0',
  `reason` varchar(64) NOT NULL DEFAULT '',
  `created_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_account_time` (`account`,`created_at`),
  KEY `idx_ip_time` (`ip`,`created_at`)
) ENGINE=InnoDB AUTO_INCREMENT=125 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_order`
--

DROP TABLE IF EXISTS `mp_order`;
CREATE TABLE `mp_order` (
  `id` varchar(40) NOT NULL,
  `order_no` varchar(40) NOT NULL,
  `user_id` bigint NOT NULL,
  `brand_id` varchar(32) NOT NULL DEFAULT '',
  `store_id` varchar(32) NOT NULL,
  `store_type` varchar(16) NOT NULL DEFAULT 'DIRECT' COMMENT '下单时门店类型快照，便于分账统计',
  `status` varchar(16) NOT NULL,
  `dining_type` varchar(16) NOT NULL DEFAULT 'dinein',
  `table_no` varchar(16) NOT NULL DEFAULT '',
  `people_count` int NOT NULL DEFAULT '1',
  `remark` varchar(255) NOT NULL DEFAULT '',
  `soup_id` varchar(32) NOT NULL DEFAULT '',
  `soup_name` varchar(64) NOT NULL DEFAULT '',
  `soup_price` int NOT NULL DEFAULT '0',
  `dip_ids` varchar(255) NOT NULL DEFAULT '[]',
  `dip_names` varchar(255) NOT NULL DEFAULT '',
  `item_count` int NOT NULL DEFAULT '0',
  `goods_amount` int NOT NULL DEFAULT '0',
  `soup_fee` int NOT NULL DEFAULT '0',
  `pack_fee` int NOT NULL DEFAULT '0',
  `discount` int NOT NULL DEFAULT '0',
  `pay_amount` int NOT NULL DEFAULT '0',
  `coupon_id` varchar(32) NOT NULL DEFAULT '',
  `pickup_no` varchar(16) NOT NULL DEFAULT '',
  `parent_order_id` varchar(40) NOT NULL DEFAULT '' COMMENT '加菜场景的上游订单',
  `pay_txn_id` varchar(64) NOT NULL DEFAULT '',
  `pay_time` bigint NOT NULL DEFAULT '0',
  `finish_time` bigint NOT NULL DEFAULT '0',
  `cancel_time` bigint NOT NULL DEFAULT '0',
  `cancel_reason` varchar(128) NOT NULL DEFAULT '',
  `urge_count` int NOT NULL DEFAULT '0',
  `last_urge_at` bigint NOT NULL DEFAULT '0',
  `rated` tinyint NOT NULL DEFAULT '0',
  `points_granted` tinyint NOT NULL DEFAULT '0' COMMENT '积分是否已发放，防重复发放',
  `created_at` bigint NOT NULL,
  `updated_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order_no` (`order_no`),
  UNIQUE KEY `uk_idem` (`id`),
  KEY `idx_user_time` (`user_id`,`created_at`),
  KEY `idx_user_status` (`user_id`,`status`,`created_at`),
  KEY `idx_status_time` (`status`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_order_item`
--

DROP TABLE IF EXISTS `mp_order_item`;
CREATE TABLE `mp_order_item` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `order_id` varchar(40) NOT NULL,
  `dish_id` varchar(32) NOT NULL,
  `dish_name` varchar(128) NOT NULL,
  `emoji` varchar(8) NOT NULL DEFAULT '',
  `price` int NOT NULL,
  `unit` varchar(16) NOT NULL DEFAULT '份',
  `quantity` int NOT NULL,
  `spicy_id` varchar(16) NOT NULL DEFAULT '',
  `spicy_name` varchar(32) NOT NULL DEFAULT '',
  `amount` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order` (`order_id`),
  KEY `idx_dish` (`dish_id`)
) ENGINE=InnoDB AUTO_INCREMENT=827 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_order_log`
--

DROP TABLE IF EXISTS `mp_order_log`;
CREATE TABLE `mp_order_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `order_id` varchar(40) NOT NULL,
  `from_status` varchar(16) NOT NULL DEFAULT '',
  `to_status` varchar(16) NOT NULL,
  `operator` varchar(32) NOT NULL DEFAULT 'system',
  `remark` varchar(128) NOT NULL DEFAULT '',
  `created_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order` (`order_id`)
) ENGINE=InnoDB AUTO_INCREMENT=1592 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_pay_record`
--

DROP TABLE IF EXISTS `mp_pay_record`;
CREATE TABLE `mp_pay_record` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `order_id` varchar(40) NOT NULL,
  `out_trade_no` varchar(40) NOT NULL,
  `transaction_id` varchar(64) NOT NULL DEFAULT '',
  `amount` int NOT NULL,
  `status` varchar(16) NOT NULL COMMENT 'CREATED|SUCCESS|FAIL|CLOSED|REFUNDING|REFUNDED',
  `channel` varchar(16) NOT NULL DEFAULT 'wechat',
  `raw` text,
  `created_at` bigint NOT NULL,
  `updated_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_out_trade_no` (`out_trade_no`),
  UNIQUE KEY `uk_txn` (`transaction_id`),
  KEY `idx_order` (`order_id`)
) ENGINE=InnoDB AUTO_INCREMENT=53 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_refund`
--

DROP TABLE IF EXISTS `mp_refund`;
CREATE TABLE `mp_refund` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `order_id` varchar(40) NOT NULL,
  `user_id` bigint NOT NULL,
  `amount` int NOT NULL,
  `reason` varchar(255) NOT NULL DEFAULT '',
  `status` varchar(16) NOT NULL DEFAULT 'APPLIED' COMMENT 'APPLIED|APPROVED|REJECTED|REFUNDED',
  `refund_id` varchar(64) NOT NULL DEFAULT '',
  `created_at` bigint NOT NULL,
  `updated_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order` (`order_id`),
  KEY `idx_user` (`user_id`,`status`)
) ENGINE=InnoDB AUTO_INCREMENT=27 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_seq`
--

DROP TABLE IF EXISTS `mp_seq`;
CREATE TABLE `mp_seq` (
  `name` varchar(64) NOT NULL,
  `val` bigint NOT NULL DEFAULT '0',
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_soup`
--

DROP TABLE IF EXISTS `mp_soup`;
CREATE TABLE `mp_soup` (
  `id` varchar(32) NOT NULL,
  `brand_id` varchar(32) NOT NULL,
  `name` varchar(64) NOT NULL,
  `price` int NOT NULL DEFAULT '0',
  `emoji` varchar(8) NOT NULL DEFAULT '',
  `description` varchar(255) NOT NULL DEFAULT '',
  `recommended` tinyint NOT NULL DEFAULT '0',
  `sort` int NOT NULL DEFAULT '0',
  `status` tinyint NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  KEY `idx_brand` (`brand_id`,`status`,`sort`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_spicy`
--

DROP TABLE IF EXISTS `mp_spicy`;
CREATE TABLE `mp_spicy` (
  `id` varchar(32) NOT NULL,
  `name` varchar(32) NOT NULL,
  `color` varchar(16) NOT NULL DEFAULT '#8A8A8E',
  `sort` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_staff`
--

DROP TABLE IF EXISTS `mp_staff`;
CREATE TABLE `mp_staff` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `brand_id` varchar(32) NOT NULL,
  `account` varchar(64) NOT NULL,
  `password_hash` varchar(128) NOT NULL,
  `password_salt` varchar(64) NOT NULL,
  `name` varchar(64) NOT NULL DEFAULT '',
  `phone` varchar(32) NOT NULL DEFAULT '',
  `role` varchar(32) NOT NULL,
  `region` varchar(64) NOT NULL DEFAULT '' COMMENT '区域经理授权的大区',
  `all_stores` tinyint NOT NULL DEFAULT '0' COMMENT '1=品牌超管，可见全部门店',
  `must_change_pwd` tinyint NOT NULL DEFAULT '0',
  `status` tinyint NOT NULL DEFAULT '1' COMMENT '0停用 1启用',
  `last_login_at` bigint NOT NULL DEFAULT '0',
  `fail_count` int NOT NULL DEFAULT '0',
  `locked_until` bigint NOT NULL DEFAULT '0',
  `created_at` bigint NOT NULL,
  `updated_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_account` (`brand_id`,`account`),
  KEY `idx_role` (`brand_id`,`role`)
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_staff_store`
--

DROP TABLE IF EXISTS `mp_staff_store`;
CREATE TABLE `mp_staff_store` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `staff_id` bigint NOT NULL,
  `store_id` varchar(32) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_staff_store` (`staff_id`,`store_id`),
  KEY `idx_store` (`store_id`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_store`
--

DROP TABLE IF EXISTS `mp_store`;
CREATE TABLE `mp_store` (
  `id` varchar(32) NOT NULL,
  `brand_id` varchar(32) NOT NULL,
  `code` varchar(32) NOT NULL DEFAULT '',
  `name` varchar(128) NOT NULL,
  `type` varchar(16) NOT NULL DEFAULT 'DIRECT' COMMENT 'DIRECT直营|FRANCHISE加盟',
  `franchisee` varchar(128) NOT NULL DEFAULT '' COMMENT '加盟商主体名称',
  `region` varchar(64) NOT NULL DEFAULT '' COMMENT '大区，区域经理按此授权',
  `city` varchar(64) NOT NULL DEFAULT '',
  `address` varchar(255) NOT NULL DEFAULT '',
  `phone` varchar(32) NOT NULL DEFAULT '',
  `latitude` decimal(10,6) NOT NULL DEFAULT '0.000000',
  `longitude` decimal(10,6) NOT NULL DEFAULT '0.000000',
  `open_time` varchar(64) NOT NULL DEFAULT '',
  `per_capita` int NOT NULL DEFAULT '0',
  `tables_json` varchar(512) NOT NULL DEFAULT '[]' COMMENT '堂食桌号',
  `status` tinyint NOT NULL DEFAULT '1' COMMENT '0停业 1营业',
  `created_at` bigint NOT NULL,
  `updated_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_code` (`brand_id`,`code`),
  KEY `idx_brand` (`brand_id`,`status`),
  KEY `idx_type` (`type`,`status`),
  KEY `idx_region` (`region`),
  KEY `idx_geo` (`latitude`,`longitude`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_store_dish`
--

DROP TABLE IF EXISTS `mp_store_dish`;
CREATE TABLE `mp_store_dish` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `store_id` varchar(32) NOT NULL,
  `dish_id` varchar(32) NOT NULL,
  `price_override` int NOT NULL DEFAULT '0' COMMENT '0=用总部指导价',
  `stock` int NOT NULL DEFAULT '0',
  `sold` int NOT NULL DEFAULT '0',
  `status` tinyint NOT NULL DEFAULT '1' COMMENT '0本店停售 1在售',
  `updated_at` bigint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_store_dish` (`store_id`,`dish_id`),
  KEY `idx_dish` (`dish_id`),
  KEY `idx_store` (`store_id`,`status`)
) ENGINE=InnoDB AUTO_INCREMENT=151 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_theme`
--

DROP TABLE IF EXISTS `mp_theme`;
CREATE TABLE `mp_theme` (
  `id` varchar(32) NOT NULL,
  `brand_id` varchar(32) NOT NULL,
  `store_id` varchar(32) NOT NULL DEFAULT '' COMMENT '空=品牌级主题',
  `name` varchar(64) NOT NULL,
  `type` varchar(24) NOT NULL DEFAULT 'CUSTOM' COMMENT 'NORMAL|CAMPAIGN|HOLIDAY|MEMBER_DAY|CUSTOM',
  `tokens_json` text,
  `description` varchar(255) NOT NULL DEFAULT '',
  `start_at` bigint NOT NULL DEFAULT '0',
  `end_at` bigint NOT NULL DEFAULT '0',
  `priority` int NOT NULL DEFAULT '0',
  `status` tinyint NOT NULL DEFAULT '1' COMMENT '0停用 1启用',
  `created_by` bigint NOT NULL DEFAULT '0',
  `created_at` bigint NOT NULL,
  `updated_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_brand` (`brand_id`,`status`,`priority`),
  KEY `idx_store` (`store_id`,`status`,`priority`),
  KEY `idx_window` (`start_at`,`end_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_user`
--

DROP TABLE IF EXISTS `mp_user`;
CREATE TABLE `mp_user` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `openid` varchar(64) NOT NULL,
  `unionid` varchar(64) NOT NULL DEFAULT '',
  `nickname` varchar(64) NOT NULL DEFAULT '串串香食客',
  `avatar` varchar(512) NOT NULL DEFAULT '',
  `phone` varchar(32) NOT NULL DEFAULT '',
  `gender` tinyint NOT NULL DEFAULT '0' COMMENT '0未知 1男 2女',
  `birthday` varchar(16) NOT NULL DEFAULT '' COMMENT 'YYYY-MM-DD',
  `city` varchar(64) NOT NULL DEFAULT '',
  `member_level` int NOT NULL DEFAULT '1',
  `member_name` varchar(32) NOT NULL DEFAULT '铜签会员',
  `points` int NOT NULL DEFAULT '0',
  `status` tinyint NOT NULL DEFAULT '1' COMMENT '0已注销 1正常',
  `cancel_at` bigint NOT NULL DEFAULT '0' COMMENT '注销时间',
  `created_at` bigint NOT NULL,
  `updated_at` bigint NOT NULL,
  `last_login_at` bigint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_openid` (`openid`)
) ENGINE=InnoDB AUTO_INCREMENT=1395 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_user_coupon`
--

DROP TABLE IF EXISTS `mp_user_coupon`;
CREATE TABLE `mp_user_coupon` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL,
  `coupon_id` varchar(32) NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'UNUSED' COMMENT 'UNUSED|USED|EXPIRED',
  `order_id` varchar(40) NOT NULL DEFAULT '',
  `got_at` bigint NOT NULL,
  `used_at` bigint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_coupon` (`user_id`,`coupon_id`,`id`),
  KEY `idx_user_status` (`user_id`,`status`)
) ENGINE=InnoDB AUTO_INCREMENT=1492 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_voucher`
--

DROP TABLE IF EXISTS `mp_voucher`;
CREATE TABLE `mp_voucher` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `platform` varchar(16) NOT NULL DEFAULT 'MEITUAN' COMMENT 'MEITUAN|DOUYIN|MANUAL',
  `code` varchar(64) NOT NULL COMMENT '券码',
  `brand_id` varchar(32) NOT NULL DEFAULT '',
  `store_id` varchar(32) NOT NULL,
  `deal_id` varchar(64) NOT NULL DEFAULT '' COMMENT '团购套餐 id',
  `product_name` varchar(128) NOT NULL DEFAULT '',
  `face_value` int NOT NULL DEFAULT '0' COMMENT '面值（分）',
  `quantity` int NOT NULL DEFAULT '1',
  `status` varchar(16) NOT NULL DEFAULT 'VERIFIED' COMMENT 'VERIFIED|REFUNDED|FAILED',
  `verified_by` bigint NOT NULL DEFAULT '0' COMMENT '核销人（员工 id，0=用户自助）',
  `verified_at` bigint NOT NULL DEFAULT '0',
  `user_id` bigint NOT NULL DEFAULT '0' COMMENT '自助核销的用户',
  `order_id` varchar(40) NOT NULL DEFAULT '' COMMENT '联动生成的订单',
  `channel` varchar(16) NOT NULL DEFAULT 'STAFF' COMMENT 'STAFF店员核销|SELF用户自助',
  `raw` text,
  `created_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_platform_code` (`platform`,`code`),
  KEY `idx_store_time` (`store_id`,`created_at`),
  KEY `idx_time` (`created_at`)
) ENGINE=InnoDB AUTO_INCREMENT=85 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;



--
-- Table structure for table `mp_address`
-- （「我的 → 地址管理」：用户收货/联系地址）
--

DROP TABLE IF EXISTS `mp_address`;
CREATE TABLE `mp_address` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL,
  `name` varchar(32) NOT NULL,
  `phone` varchar(20) NOT NULL,
  `province` varchar(32) NOT NULL DEFAULT '',
  `city` varchar(32) NOT NULL DEFAULT '',
  `district` varchar(32) NOT NULL DEFAULT '',
  `detail` varchar(200) NOT NULL,
  `tag` varchar(16) NOT NULL DEFAULT '' COMMENT '家|公司|学校',
  `is_default` tinyint NOT NULL DEFAULT '0',
  `created_at` bigint NOT NULL,
  `updated_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`,`is_default`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_service_ticket`
-- （「我的 → 在线客服」：会话主表，一个用户同时只有一个 OPEN 会话）
--

DROP TABLE IF EXISTS `mp_service_ticket`;
CREATE TABLE `mp_service_ticket` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL,
  `store_id` varchar(32) NOT NULL DEFAULT '',
  `status` varchar(16) NOT NULL DEFAULT 'OPEN' COMMENT 'OPEN|CLOSED',
  `last_msg_at` bigint NOT NULL DEFAULT '0',
  `last_preview` varchar(128) NOT NULL DEFAULT '',
  `user_unread` int NOT NULL DEFAULT '0',
  `admin_unread` int NOT NULL DEFAULT '0',
  `created_at` bigint NOT NULL,
  `updated_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user_time` (`user_id`,`status`,`updated_at`),
  KEY `idx_admin_unread` (`admin_unread`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_service_message`
--

DROP TABLE IF EXISTS `mp_service_message`;
CREATE TABLE `mp_service_message` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `ticket_id` bigint NOT NULL,
  `user_id` bigint NOT NULL DEFAULT '0',
  `sender` varchar(16) NOT NULL COMMENT 'USER|ADMIN|SYSTEM',
  `msg_type` varchar(16) NOT NULL DEFAULT 'text' COMMENT 'text|image|video|voice|file',
  `content` text,
  `media_url` varchar(512) NOT NULL DEFAULT '',
  `media_meta` varchar(512) NOT NULL DEFAULT '' COMMENT 'JSON: duration/size/name/width/height',
  `created_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ticket` (`ticket_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_agreement`
-- （「我的 → 协议及政策」，内容后台可维护）
--

DROP TABLE IF EXISTS `mp_agreement`;
CREATE TABLE `mp_agreement` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `code` varchar(32) NOT NULL,
  `title` varchar(64) NOT NULL,
  `summary` varchar(200) NOT NULL DEFAULT '',
  `content_html` mediumtext,
  `version` varchar(16) NOT NULL DEFAULT 'v1.0',
  `sort` int NOT NULL DEFAULT '0',
  `status` tinyint NOT NULL DEFAULT '1',
  `updated_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_invoice_request`
-- （「我的 → 发票管理」：开票申请，一笔订单仅一张，驳回后可复用同行重提）
--

DROP TABLE IF EXISTS `mp_invoice_request`;
CREATE TABLE `mp_invoice_request` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `title_id` bigint NOT NULL DEFAULT '0',
  `user_id` bigint NOT NULL,
  `order_id` varchar(40) NOT NULL,
  `order_no` varchar(40) NOT NULL DEFAULT '',
  `store_id` varchar(32) NOT NULL DEFAULT '',
  `amount` int NOT NULL DEFAULT '0',
  `title_type` varchar(16) NOT NULL DEFAULT 'personal',
  `title` varchar(128) NOT NULL,
  `tax_no` varchar(64) NOT NULL DEFAULT '',
  `email` varchar(128) NOT NULL DEFAULT '',
  `status` varchar(16) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING|PROCESSING|ISSUED|REJECTED',
  `invoice_no` varchar(64) NOT NULL DEFAULT '',
  `invoice_url` varchar(512) NOT NULL DEFAULT '',
  `remark` varchar(255) NOT NULL DEFAULT '',
  `applied_at` bigint NOT NULL,
  `issued_at` bigint NOT NULL DEFAULT '0',
  `updated_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order` (`order_id`),
  KEY `idx_user` (`user_id`,`applied_at`),
  KEY `idx_status` (`status`,`applied_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_franchise_config`
-- （「我的 → 加盟咨询」：海报与企微二维码配置，单行，后台可改）
--

DROP TABLE IF EXISTS `mp_franchise_config`;
CREATE TABLE `mp_franchise_config` (
  `id` varchar(32) NOT NULL,
  `brand_id` varchar(32) NOT NULL DEFAULT 'brand_lbz',
  `title` varchar(64) NOT NULL DEFAULT '老北京麻辣串串香 · 加盟合作',
  `subtitle` varchar(128) NOT NULL DEFAULT '',
  `highlights` varchar(1024) NOT NULL DEFAULT '[]' COMMENT 'JSON 数组：[{icon,label,value}]',
  `poster_url` varchar(512) NOT NULL DEFAULT '' COMMENT '整张海报图（可选，留空则用内置版式）',
  `qr_url` varchar(512) NOT NULL DEFAULT '' COMMENT '企业微信二维码（后台可换）',
  `qr_tip` varchar(128) NOT NULL DEFAULT '长按识别添加加盟顾问企业微信',
  `consult_phone` varchar(32) NOT NULL DEFAULT '',
  `wecom_id` varchar(64) NOT NULL DEFAULT '',
  `updated_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_brand` (`brand_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Table structure for table `mp_user_cancel_log`
-- （账号注销留痕：openid 只存 SHA-256，避免注销后仍可反查用户）
--

DROP TABLE IF EXISTS `mp_user_cancel_log`;
CREATE TABLE `mp_user_cancel_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL,
  `openid_hash` varchar(64) NOT NULL DEFAULT '',
  `reason` varchar(255) NOT NULL DEFAULT '',
  `created_at` bigint NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;



SET FOREIGN_KEY_CHECKS = 1;

-- ===== [2/2] admin_init.sql =====
-- ============================================================
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
