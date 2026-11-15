CREATE TABLE `plans` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`title` text NOT NULL,
	`revision` integer NOT NULL,
	`origin` text DEFAULT 'local' NOT NULL,
	`updated_at` integer NOT NULL,
	`document` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plans_updated_at_idx` ON `plans` (`updated_at`);