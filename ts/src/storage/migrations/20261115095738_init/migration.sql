CREATE TABLE `profiles` (
	`name` text PRIMARY KEY,
	`imported_at` integer NOT NULL,
	`document` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY,
	`profile` text NOT NULL,
	`adapter` text NOT NULL,
	`started_at` integer NOT NULL,
	`stopped_at` integer,
	`notes` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`run_id` text NOT NULL,
	`signal` text NOT NULL,
	`unit` text NOT NULL,
	`timestamp` integer NOT NULL,
	`value_num` real,
	`value_text` text,
	CONSTRAINT `fk_samples_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT "samples_one_value" CHECK(("value_num" is null) <> ("value_text" is null))
);
--> statement-breakpoint
CREATE TABLE `scan_reports` (
	`id` text PRIMARY KEY,
	`profile` text NOT NULL,
	`adapter` text NOT NULL,
	`taken_at` integer NOT NULL,
	`label` text NOT NULL,
	`report` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runs_started_at_idx` ON `runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `samples_run_signal_time_idx` ON `samples` (`run_id`,`signal`,`timestamp`);--> statement-breakpoint
CREATE INDEX `samples_run_time_idx` ON `samples` (`run_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `scan_reports_taken_at_idx` ON `scan_reports` (`taken_at`);