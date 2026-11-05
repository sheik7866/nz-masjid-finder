// POST /api/ai-jummah/start — admin only. Body: { ids?: string[] } (omit for every masjid website).
// Verifies the Supabase admin session, then hands the work to the background worker.
import type { Config } from "@netlify/functions";
import { allMasjids, checkableMasjids, isAdminRequest } from "../lib/jummah-check.mjs";

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!(await isAdminRequest(req))) return Response.json({ error: "Admin sign-in required" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const known = new Set(checkableMasjids().map((m) => m.id));
  const ids: string[] = Array.isArray(body?.ids)
    ? body.ids.filter((x: unknown) => typeof x === "string" && known.has(x)).slice(0, 200)
    : [...known];
  if (!ids.length) {
    const exists = Array.isArray(body?.ids) && body.ids.some((x: string) => allMasjids().some((m) => m.id === x));
    return Response.json({ error: exists ? "That masjid has no readable website" : "Nothing to check" }, { status: 400 });
  }

  const res = await fetch(new URL("/api/ai-jummah/worker", req.url), {
    method: "POST",
    headers: { Authorization: req.headers.get("authorization") || "", "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (res.status !== 202 && !res.ok) return Response.json({ error: "Could not start the check" }, { status: 502 });
  return Response.json({ started: ids.length }, { status: 202 });
};

export const config: Config = { path: "/api/ai-jummah/start" };
