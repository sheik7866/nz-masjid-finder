// Hourly: re-reads the one masjid website whose AI check is missing or oldest (past 7 days),
// so every reading stays roughly a week fresh without a big burst of work.
import type { Config } from "@netlify/functions";
import { checkMasjid, saveResult, staleMasjids } from "../lib/jummah-check.mjs";

export default async () => {
  try {
    const [m] = await staleMasjids(1);
    if (!m) return;
    const r = await checkMasjid(m);
    await saveResult(r);
    console.log(`ai-jummah scheduled: ${m.name} → ${r.status}`);
  } catch (e) {
    console.error("ai-jummah scheduled failed", e);
  }
};

export const config: Config = { schedule: "@hourly" };
