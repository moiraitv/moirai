CREATE TABLE `authentication_initialization` (
	`id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
	`method` text NOT NULL CHECK (`method` IN ('local', 'logto')),
	`initialized_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `authentication_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL CHECK (`provider` IN ('local', 'logto')),
	`provider_issuer` text,
	`provider_subject` text,
	`display_name` text NOT NULL,
	`username` text,
	`username_key` text,
	`password_hash` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `authentication_identity_provider_subject`
	ON `authentication_identities` (`provider`, `provider_issuer`, `provider_subject`);
--> statement-breakpoint
CREATE UNIQUE INDEX `authentication_identity_username_key`
	ON `authentication_identities` (`username_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `authentication_single_local_identity`
	ON `authentication_identities` (`provider`) WHERE `provider` = 'local';
--> statement-breakpoint
CREATE TABLE `authentication_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL REFERENCES `authentication_identities`(`id`) ON DELETE CASCADE,
	`csrf_token` text NOT NULL,
	`provider_session_id` text,
	`provider_logout_hint` text,
	`provider_configuration_hash` text,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `authentication_sessions_identity_idx` ON `authentication_sessions` (`identity_id`);
--> statement-breakpoint
CREATE INDEX `authentication_sessions_provider_sid_idx` ON `authentication_sessions` (`provider_session_id`);
--> statement-breakpoint
CREATE INDEX `authentication_sessions_expiry_idx` ON `authentication_sessions` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `authentication_oidc_transactions` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`binding_hash` text NOT NULL,
	`code_verifier` text NOT NULL,
	`nonce` text NOT NULL,
	`return_to` text NOT NULL,
	`logout_generation` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `authentication_oidc_expiry_idx`
	ON `authentication_oidc_transactions` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `authentication_oidc_logout_generation` (
	`id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
	`generation` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `authentication_oidc_logout_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `authentication_oidc_logout_expiry_idx`
	ON `authentication_oidc_logout_tokens` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `authentication_recovery_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `authentication_recovery_expiry_idx`
	ON `authentication_recovery_tokens` (`expires_at`);
