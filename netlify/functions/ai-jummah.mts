// GET /api/ai-jummah — public list of the latest AI website readings.
// If some masjid websites have never been read (or are over 7 days old) and no batch is
// running, it also kicks off the background worker, so results fill in on their own.
import type { Config, Context } from "@netlify/functions";
import { checkableMasjids, listResults, runInProgress, staleMasjids } from "../lib/jummah-check.mjs";

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  try {
    const [rows, running, stale] = await Promise.all([listResults(), runInProgress(), staleMasjids(1)]);
    let refreshing = running;
    if (!running && stale.length) {
      refreshing = true;
      context.waitUntil(
        fetch(new URL("/api/ai-jummah/worker", req.url), { method: "POST", body: "{}" })
          .catch((e) => console.error("could not start ai-jummah worker", e)),
      );
    }
    return Response.json(
      { checkable: checkableMasjids().length, refreshing, results: rows },
      { headers: { "Cache-Control": "public, max-age=30" } },
    );
  } catch (e) {
    console.error("ai-jummah list failed", e);
    return Response.json({ checkable: checkableMasjids().length, results: [], error: "unavailable" }, { status: 503 });
  }
};

export const config: Config = { path: "/api/ai-jummah" };
