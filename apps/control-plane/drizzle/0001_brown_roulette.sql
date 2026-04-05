CREATE TABLE "resource_spans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"resource_address" text NOT NULL,
	"resource_type" text,
	"action" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"source" text DEFAULT 'log_parse' NOT NULL,
	"trace_id" text,
	"span_id" text,
	"parent_span_id" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resource_spans" ADD CONSTRAINT "resource_spans_run_id_tf_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."tf_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_spans_run_id_idx" ON "resource_spans" USING btree ("run_id");