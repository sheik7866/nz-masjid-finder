import { pgTable, text, timestamp, jsonb, real } from "drizzle-orm/pg-core";

/**
 * One row per masjid: the latest AI reading of its own website for Jumu'ah times.
 * This is NOT a human verification — the app shows it with an "AI-checked" label,
 * the exact quote it came from and a link to the page, so a person can confirm it.
 */
export const aiJummahChecks = pgTable("ai_jummah_checks", {
  masjidId: text("masjid_id").primaryKey(),
  masjidName: text("masjid_name").notNull(),
  website: text("website"),
  // found | not_found | unreachable | error
  status: text("status").notNull(),
  jummahTimes: text("jummah_times"),
  evidence: text("evidence"),
  sourceUrl: text("source_url"),
  confidence: real("confidence"),
  notes: text("notes"),
  pagesChecked: jsonb("pages_checked").$type<string[]>().default([]),
  model: text("model"),
  checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
});
