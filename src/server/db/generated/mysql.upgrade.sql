CREATE TABLE IF NOT EXISTS `site_concurrency_leases` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `site_id` INT NOT NULL, `lease_token` TEXT NOT NULL, `slot` INT NOT NULL, `expires_at` VARCHAR(191) NOT NULL, `created_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')), `updated_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')), FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE);
ALTER TABLE `sites` ADD COLUMN `max_concurrency` INT;
ALTER TABLE `sites` ADD COLUMN `concurrency_wait_timeout_ms` INT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX `site_concurrency_leases_site_slot_unique` ON `site_concurrency_leases` (`site_id`, `slot`);
CREATE UNIQUE INDEX `site_concurrency_leases_token_unique` ON `site_concurrency_leases` (`lease_token`(191));
CREATE INDEX `site_concurrency_leases_expires_at_idx` ON `site_concurrency_leases` (`expires_at`);
CREATE INDEX `site_concurrency_leases_site_id_idx` ON `site_concurrency_leases` (`site_id`);
