// Background worker (up to 15 min): reads masjid websites and stores the AI reading.
// - Admin call with { ids }: re-checks exactly those masjids now.
// - Any other call: only checks masjids with no result or a result older than 7 days,
//   so it can be triggered from page visits without letting anyone force repeat work.
import type { Config } from "@netlify/functions";
import {
  checkMasjid, checkableMasjids, isAdminRequest, runInProgress, saveResult, setRunLock, staleMasjids,
} from "../lib/jummah-check.mjs";

const CONCURRENCY = 4;

export default async (req: Request) => {
  try {
    const body = await req.json().catch(() => ({}));
    const admin = Array.isArray(body?.ids) && (await isAdminRequest(req));
    let queue;
    if (admin) {
      const wanted = new Set<string>(body.ids);
      queue = checkableMasjids().filter((m) => wanted.has(m.id));
    } else {
      if (await runInProgress()) return;
      queue = await staleMasjids(60);
    }
    if (!queue.length) return;
    await setRunLock(true);
    let done = 0;
    const run = async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        try {
          const r = await checkMasjid(m);
          await saveResult(r);
          console.log(`ai-jummah ${++done}: ${m.name} → ${r.status}`);
        } catch (e) {
          console.error("ai-jummah worker item failed", m.id, e);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, run));
    await setRunLock(false);
  } catch (e) {
    // swallow so the platform does not retry a half-finished batch
    console.error("ai-jummah worker failed", e);
  }
};

export const config: Config = { path: "/api/ai-jummah/worker", background: true };
