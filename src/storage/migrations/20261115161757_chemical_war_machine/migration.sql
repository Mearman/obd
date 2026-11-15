ALTER TABLE `captures` ADD `origin` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `origin` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `scan_reports` ADD `origin` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
-- Records from before this column: a capture imported from a file, and a scan the app saved from a share link (which it stored under the adapter shared://link).
UPDATE `captures` SET `origin` = 'imported' WHERE `kind` = 'import';--> statement-breakpoint
UPDATE `scan_reports` SET `origin` = 'shared' WHERE `adapter` = 'shared://link';
