ALTER TABLE "exploration_steps" ADD COLUMN "suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "explorations" ADD COLUMN "screens" jsonb DEFAULT '[]'::jsonb NOT NULL;