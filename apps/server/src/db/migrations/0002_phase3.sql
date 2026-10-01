CREATE TABLE "brain_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"attempt" integer NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"tokens_cached" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 6) DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"ref_type" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"content_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_calls_role" CHECK (role in ('explorer', 'writer')),
	CONSTRAINT "brain_calls_error" CHECK (error is null or error in ('timeout', 'rate_limited', 'auth', 'refusal', 'invalid_output', 'provider_error', 'budget')),
	CONSTRAINT "brain_calls_ref_type" CHECK (ref_type in ('exploration', 'import_job')),
	CONSTRAINT "brain_calls_attempt" CHECK ("brain_calls"."attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE "exploration_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"exploration_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"segment" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"screen_id" text,
	"decision" jsonb,
	"status" text NOT NULL,
	"refusal" text,
	"step" jsonb,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"artifact_prefix" text,
	"brain_call_id" uuid,
	"cost_usd" numeric(14, 6) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exploration_steps_status" CHECK (status in ('done', 'refused', 'failed', 'popup', 'restart')),
	CONSTRAINT "exploration_steps_refusal" CHECK (refusal is null or refusal in ('not_found', 'not_actionable', 'never_tap', 'skill_forbidden', 'point_pct_not_allowed', 'invented_submit', 'invalid_text')),
	CONSTRAINT "exploration_steps_flags" CHECK (flags <@ array['never_tap', 'mcp_value', 'invented_text']::text[])
);
--> statement-breakpoint
CREATE TABLE "explorations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"lease_id" uuid,
	"kind" text NOT NULL,
	"goal" text,
	"budget" jsonb NOT NULL,
	"max_tests" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stop_reason" text,
	"stats" jsonb DEFAULT '{"steps":0,"refused":0,"screens":0,"new_screens":0,"transitions":0,"findings":0,"cost_usd":0,"tests_written":0,"tests_active":0}'::jsonb NOT NULL,
	"appmap_commit" text,
	"import_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "explorations_kind" CHECK (kind in ('explore', 'prompt', 'import')),
	CONSTRAINT "explorations_status" CHECK (status in ('queued', 'running', 'writing', 'validating', 'done', 'stopped', 'failed', 'interrupted')),
	CONSTRAINT "explorations_stop_reason" CHECK (stop_reason is null or stop_reason in ('max_steps', 'max_depth', 'max_minutes', 'budget', 'daily_limit', 'goal_reached', 'goal_not_reached', 'user_stopped', 'device_offline', 'ai_unavailable', 'interrupted', 'error')),
	CONSTRAINT "explorations_max_tests" CHECK ("explorations"."max_tests" between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"exploration_id" uuid NOT NULL,
	"step_n" integer NOT NULL,
	"kind" text NOT NULL,
	"log_excerpt" text DEFAULT '' NOT NULL,
	"artifact_prefix" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "findings_kind" CHECK (kind in ('crashed', 'not_responding'))
);
--> statement-breakpoint
CREATE TABLE "import_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"import_job_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"manual_path" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"evidence" jsonb,
	"exploration_id" uuid,
	"test_case_id" uuid,
	"cost_usd" numeric(14, 6) DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_items_status" CHECK (status in ('pending', 'running', 'active', 'draft', 'not_processed')),
	CONSTRAINT "import_items_reason" CHECK (reason is null or reason in ('needs_human', 'ambiguous', 'app_mismatch', 'validation_failed', 'duplicate'))
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"app_id" uuid,
	"build_id" uuid,
	"device_id" uuid,
	"created_by" uuid NOT NULL,
	"source_format" text NOT NULL,
	"file_name" text NOT NULL,
	"sheet" text,
	"mapping" jsonb,
	"status" text DEFAULT 'preview' NOT NULL,
	"budget" jsonb,
	"stats" jsonb DEFAULT '{"total":0,"done":0,"active":0,"draft":0,"not_processed":0,"cost_usd":0}'::jsonb NOT NULL,
	"report" jsonb,
	"manual_commit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "import_jobs_source_format" CHECK (source_format in ('csv', 'xlsx', 'gherkin')),
	CONSTRAINT "import_jobs_status" CHECK (status in ('preview', 'running', 'done', 'cancelled', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brain_call_id" uuid NOT NULL,
	"mcp_server" text NOT NULL,
	"tool" text NOT NULL,
	"args_redacted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ok" boolean NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"error" text,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_calls_error" CHECK (error is null or error in ('not_allowed', 'side_effects_disabled', 'timeout', 'server_error'))
);
--> statement-breakpoint
ALTER TABLE "test_cases" DROP CONSTRAINT "test_cases_source";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "validation_of" uuid;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "validation" jsonb;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "draft_reason" text;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "flags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "validated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brain_calls" ADD CONSTRAINT "brain_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exploration_steps" ADD CONSTRAINT "exploration_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exploration_steps" ADD CONSTRAINT "exploration_steps_exploration_id_explorations_id_fk" FOREIGN KEY ("exploration_id") REFERENCES "public"."explorations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exploration_steps" ADD CONSTRAINT "exploration_steps_brain_call_id_brain_calls_id_fk" FOREIGN KEY ("brain_call_id") REFERENCES "public"."brain_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explorations" ADD CONSTRAINT "explorations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explorations" ADD CONSTRAINT "explorations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explorations" ADD CONSTRAINT "explorations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explorations" ADD CONSTRAINT "explorations_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explorations" ADD CONSTRAINT "explorations_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explorations" ADD CONSTRAINT "explorations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explorations" ADD CONSTRAINT "explorations_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explorations" ADD CONSTRAINT "explorations_import_item_id_import_items_id_fk" FOREIGN KEY ("import_item_id") REFERENCES "public"."import_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_exploration_id_explorations_id_fk" FOREIGN KEY ("exploration_id") REFERENCES "public"."explorations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_exploration_id_explorations_id_fk" FOREIGN KEY ("exploration_id") REFERENCES "public"."explorations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_brain_call_id_brain_calls_id_fk" FOREIGN KEY ("brain_call_id") REFERENCES "public"."brain_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brain_calls_tenant_id_created_at_index" ON "brain_calls" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "brain_calls_ref_type_ref_id_index" ON "brain_calls" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exploration_steps_exploration_id_n_index" ON "exploration_steps" USING btree ("exploration_id","n");--> statement-breakpoint
CREATE INDEX "explorations_tenant_id_project_id_created_at_index" ON "explorations" USING btree ("tenant_id","project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "explorations_status_index" ON "explorations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "findings_exploration_id_index" ON "findings" USING btree ("exploration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_items_import_job_id_n_index" ON "import_items" USING btree ("import_job_id","n");--> statement-breakpoint
CREATE INDEX "import_jobs_tenant_id_project_id_created_at_index" ON "import_jobs" USING btree ("tenant_id","project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "import_jobs_status_index" ON "import_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tool_calls_brain_call_id_index" ON "tool_calls" USING btree ("brain_call_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_validation_of_test_cases_id_fk" FOREIGN KEY ("validation_of") REFERENCES "public"."test_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_draft_reason" CHECK (draft_reason is null or draft_reason in ('validation_failed', 'changed_during_validation', 'needs_human', 'ambiguous', 'app_mismatch'));--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_flags" CHECK (flags <@ array['needs_review_never_tap']::text[]);--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_source" CHECK (source in ('manual', 'recorder', 'ai_explore', 'ai_prompt', 'ai_import'));