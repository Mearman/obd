CREATE TABLE `capture_units` (
	`capture_id` text NOT NULL,
	`position` integer NOT NULL,
	`address` text NOT NULL,
	`label` text NOT NULL,
	`exchanges` integer NOT NULL,
	`answered` integer NOT NULL,
	CONSTRAINT `capture_units_pk` PRIMARY KEY(`capture_id`, `position`),
	CONSTRAINT `fk_capture_units_capture_id_captures_id_fk` FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `captures` (
	`id` text PRIMARY KEY,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`kind` text NOT NULL,
	`profile` text,
	`complete` integer NOT NULL,
	`description` text NOT NULL,
	`adapter` text NOT NULL,
	`exchanges` integer NOT NULL,
	`document` blob NOT NULL
);
--> statement-breakpoint
CREATE INDEX `captures_started_at_idx` ON `captures` (`started_at`);