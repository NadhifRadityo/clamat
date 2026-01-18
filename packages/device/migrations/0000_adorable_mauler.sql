CREATE TABLE `deviceSettings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`mdns_counter` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "id_check_singleton" CHECK("deviceSettings"."id" = 1)
);
