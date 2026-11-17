CREATE TABLE `media_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`base_url` text NOT NULL,
	`server_key` text NOT NULL,
	`server_name` text NOT NULL,
	`client_identifier` text NOT NULL,
	`access_token` text NOT NULL,
	`allow_insecure_tls` integer NOT NULL DEFAULT 0,
	`path_replacements` text NOT NULL DEFAULT '[]',
	`created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `media_servers_provider_check` CHECK (`provider` IN ('plex', 'jellyfin', 'emby')),
	CONSTRAINT `media_servers_name_key_unique` UNIQUE (`name_key`),
	CONSTRAINT `media_servers_provider_server_key_unique` UNIQUE (`provider`, `server_key`)
);
