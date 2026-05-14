CREATE TABLE IF NOT EXISTS "request_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"protocol" text NOT NULL,
	"route" text NOT NULL,
	"backend" text NOT NULL,
	"model" text NOT NULL,
	"status_class" text NOT NULL,
	"http_status" integer NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"ttft_ms" integer,
	"latency_ms" integer NOT NULL,
	"error_code" text,
	"error_message" text,
	"agent_id" text,
	"request_id" text NOT NULL,
	"upstream_message_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_daily" (
	"day" date NOT NULL,
	"protocol" text NOT NULL,
	"backend" text NOT NULL,
	"model" text NOT NULL,
	"agent_id" text DEFAULT '_no_agent_' NOT NULL,
	"request_count" integer NOT NULL,
	"success_count" integer NOT NULL,
	"error_count" integer NOT NULL,
	"tokens_in_sum" bigint NOT NULL,
	"tokens_out_sum" bigint NOT NULL,
	"p50_ttft_ms" integer,
	"p95_ttft_ms" integer,
	"p50_latency_ms" integer NOT NULL,
	"p95_latency_ms" integer NOT NULL,
	CONSTRAINT "usage_daily_day_protocol_backend_model_agent_id_pk" PRIMARY KEY("day","protocol","backend","model","agent_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_request_log_ts_desc" ON "request_log" USING btree ("ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_request_log_agent_ts" ON "request_log" USING btree ("agent_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_request_log_status_class" ON "request_log" USING btree ("status_class");