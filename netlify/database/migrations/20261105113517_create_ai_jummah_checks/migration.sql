CREATE TABLE "ai_jummah_checks" (
	"masjid_id" text PRIMARY KEY,
	"masjid_name" text NOT NULL,
	"website" text,
	"status" text NOT NULL,
	"jummah_times" text,
	"evidence" text,
	"source_url" text,
	"confidence" real,
	"notes" text,
	"pages_checked" jsonb DEFAULT '[]',
	"model" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
