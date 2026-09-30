CREATE TABLE "device_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"live_session_id" uuid,
	"recording_id" uuid,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "device_commands_kind" CHECK (kind in ('tap', 'long_press', 'swipe', 'type', 'back', 'home', 'hide_keyboard', 'restart_app', 'prepare', 'record', 'inspect')),
	CONSTRAINT "device_commands_status" CHECK (status in ('sent', 'ok', 'failed', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "live_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_command_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "live_sessions_end_reason" CHECK (end_reason is null or end_reason in ('released', 'idle_timeout', 'agent_offline', 'replaced_by_recording'))
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"lease_id" uuid,
	"status" text DEFAULT 'recording' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"intent" text DEFAULT '' NOT NULL,
	"slug" text NOT NULL,
	"test_case_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"saved_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recordings_status" CHECK (status in ('recording', 'stopped', 'saved', 'discarded', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "leases" DROP CONSTRAINT "leases_kind";--> statement-breakpoint
ALTER TABLE "leases" DROP CONSTRAINT "leases_release_reason";--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_live_session_id_live_sessions_id_fk" FOREIGN KEY ("live_session_id") REFERENCES "public"."live_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_commands_tenant_id_device_id_created_at_index" ON "device_commands" USING btree ("tenant_id","device_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "live_sessions_one_open_per_device" ON "live_sessions" USING btree ("device_id") WHERE "live_sessions"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "recordings_tenant_id_project_id_updated_at_index" ON "recordings" USING btree ("tenant_id","project_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recordings_status_expires_at_index" ON "recordings" USING btree ("status","expires_at");--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_kind" CHECK (kind in ('run', 'exploration', 'live', 'recording'));--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_release_reason" CHECK (release_reason is null or release_reason in ('done', 'cancelled', 'timeout', 'agent_offline', 'ack_timeout', 'released', 'replaced_by_recording'));