CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"os" text,
	"version" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_status" CHECK (status in ('online', 'offline', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"package_or_bundle_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_platform" CHECK (platform in ('android', 'ios'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"version" text NOT NULL,
	"artifact_key" text NOT NULL,
	"checksum_sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"os_version" text NOT NULL,
	"api_level" integer,
	"udid" text NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_kind" CHECK (kind in ('real', 'emulator', 'simulator')),
	CONSTRAINT "devices_status" CHECK (status in ('idle', 'leased', 'offline'))
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"holder_ref" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text,
	CONSTRAINT "leases_kind" CHECK (kind in ('run', 'exploration', 'live')),
	CONSTRAINT "leases_release_reason" CHECK (release_reason is null or release_reason in ('done', 'cancelled', 'timeout', 'agent_offline', 'ack_timeout'))
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "memberships_role" CHECK (role in ('owner', 'admin', 'member', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "project_files" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"path_in_repo" text NOT NULL,
	"head_commit" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_files_project_id_kind_pk" PRIMARY KEY("project_id","kind"),
	CONSTRAINT "project_files_kind" CHECK (kind in ('popups'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"git_repo_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"test_case_id" uuid NOT NULL,
	"commit" text NOT NULL,
	"position" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"failed_step_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "run_items_status" CHECK (status in ('pending', 'running', 'passed', 'failed', 'skipped', 'error'))
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_item_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"step_id" text NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"locator_used_index" integer,
	"degraded" boolean DEFAULT false NOT NULL,
	"unstable" boolean DEFAULT false NOT NULL,
	"duration_ms" integer NOT NULL,
	"failure_code" text,
	"message" text,
	"popups_handled" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"artifact_prefix" text NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_steps_status" CHECK (status in ('passed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_code" text,
	"popups_commit" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_by" uuid,
	CONSTRAINT "runs_status" CHECK (status in ('queued', 'running', 'passed', 'failed', 'cancelled', 'error')),
	CONSTRAINT "runs_trigger" CHECK (trigger in ('manual', 'schedule', 'ci', 'validation'))
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"plan" text DEFAULT 'dev' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"path_in_repo" text NOT NULL,
	"intent" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"platforms" text[] NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"head_commit" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_cases_status" CHECK (status in ('draft', 'active', 'quarantined')),
	CONSTRAINT "test_cases_source" CHECK (source in ('manual', 'recorder', 'ai_prompt', 'ai_import'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_items" ADD CONSTRAINT "run_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_items" ADD CONSTRAINT "run_items_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_items" ADD CONSTRAINT "run_items_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_item_id_run_items_id_fk" FOREIGN KEY ("run_item_id") REFERENCES "public"."run_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_token_hash_index" ON "agents" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_project_id_platform_package_or_bundle_id_index" ON "apps" USING btree ("project_id","platform","package_or_bundle_id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_id_created_at_index" ON "audit_log" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "builds_app_id_created_at_index" ON "builds" USING btree ("app_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "devices_agent_id_udid_index" ON "devices" USING btree ("agent_id","udid");--> statement-breakpoint
CREATE UNIQUE INDEX "leases_one_open_per_device" ON "leases" USING btree ("device_id") WHERE "leases"."released_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_tenant_id_name_index" ON "projects" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_token_hash_index" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "run_items_run_id_position_index" ON "run_items" USING btree ("run_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_run_item_id_step_index_index" ON "run_steps" USING btree ("run_item_id","step_index");--> statement-breakpoint
CREATE INDEX "runs_tenant_id_queued_at_index" ON "runs" USING btree ("tenant_id","queued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "test_cases_project_id_slug_index" ON "test_cases" USING btree ("project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_index" ON "users" USING btree ("email");