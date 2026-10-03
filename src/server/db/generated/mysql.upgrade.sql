ALTER TABLE `model_availability` ADD COLUMN `context_length` INT;
ALTER TABLE `model_availability` ADD COLUMN `context_source` TEXT;
ALTER TABLE `model_availability` ADD COLUMN `context_updated_at` VARCHAR(191);
ALTER TABLE `token_model_availability` ADD COLUMN `context_length` INT;
ALTER TABLE `token_model_availability` ADD COLUMN `context_source` TEXT;
ALTER TABLE `token_model_availability` ADD COLUMN `context_updated_at` VARCHAR(191);
