CREATE TABLE `audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`release_id` text,
	`detail` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `catalogs` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`envelope` text NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `firmware` (
	`id` text PRIMARY KEY NOT NULL,
	`board` text NOT NULL,
	`arch` text NOT NULL,
	`channel` text NOT NULL,
	`version` text NOT NULL,
	`generation` integer NOT NULL,
	`firmware_id` text NOT NULL,
	`firmware` text NOT NULL,
	`artifact_sha256` text NOT NULL,
	`artifact_bytes` integer NOT NULL,
	`notes` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`published_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `firmware_identity` ON `firmware` (`board`,`channel`,`generation`);--> statement-breakpoint
CREATE TABLE `objects` (
	`sha256` text PRIMARY KEY NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `release_objects` (
	`release_id` text NOT NULL,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	PRIMARY KEY(`release_id`, `sha256`),
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`board` text NOT NULL,
	`arch` text NOT NULL,
	`channel` text NOT NULL,
	`version` text NOT NULL,
	`generation` integer NOT NULL,
	`deployment_id` text NOT NULL,
	`deployment` text NOT NULL,
	`notes` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`published_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_identity` ON `releases` (`board`,`channel`,`generation`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
