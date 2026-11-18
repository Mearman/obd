CREATE TABLE `vehicle_plates` (
	`id` text PRIMARY KEY,
	`vehicle_id` text NOT NULL,
	`plate` text NOT NULL,
	`valid_from` integer,
	`valid_to` integer,
	CONSTRAINT `fk_vehicle_plates_vehicle_id_vehicles_id_fk` FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON DELETE CASCADE,
	CONSTRAINT "vehicle_plates_period" CHECK("valid_from" is null or "valid_to" is null or "valid_from" < "valid_to")
);
--> statement-breakpoint
CREATE TABLE `vehicles` (
	`id` text PRIMARY KEY,
	`vin` text UNIQUE,
	`label` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE `captures` ADD `plate` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `plate` text;--> statement-breakpoint
ALTER TABLE `scan_reports` ADD `plate` text;--> statement-breakpoint
CREATE INDEX `vehicle_plates_plate_idx` ON `vehicle_plates` (`plate`,`valid_from`);--> statement-breakpoint
-- A vehicle for each VIN a record read on this device holds, as saving such a record from now on adds one; records saved from a link or a file add none. Ids are random, like the ids storage gives.
INSERT INTO `vehicles` (`id`, `vin`, `label`)
SELECT lower(hex(randomblob(16))), `vin`, '' FROM (
  SELECT `vin` FROM `runs` WHERE `origin` = 'local' AND `vin` IS NOT NULL
  UNION SELECT `vin` FROM `captures` WHERE `origin` = 'local' AND `vin` IS NOT NULL
  UNION SELECT `vin` FROM `scan_reports` WHERE `origin` = 'local' AND `vin` IS NOT NULL
);