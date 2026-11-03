// Supabase REST client contract tests (supabase.js) with a fake fetch.
// No verification.js here - the sync engine has its own suite in sync.test.cjs.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

function makeSB(config, fetchImpl) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const sandbox = {
    localStorage, console, JSON, Date, Math, Promise, Error, Array, Object, String, Number,
    encodeURIComponent, setTimeout, clearTimeout,
    fetch: fetchImpl,
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.NZ_CONFIG = config;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/supabase.js"), "utf8"), sandbox, { filename: "supabase.js" });
  return sandbox.NZSupabase;
}

const json = (body, status = 200) => Promise.resolve({
  ok: status < 400, status,
  statusText: status < 400 ? "OK" : "Error",
  text: () => Promise.resolve(JSON.stringify(body)),
  json: () => Promise.resolve(body),
});

const DEMO = { supabaseUrl: "https://demo.supabase.co", supabaseAnonKey: "anon" };
const pending = [];
const ok = (name, fn) => { pending.push({ name, fn }); };

ok("without config the client reports disabled", async () => {
  const SB = makeSB({}, () => Promise.reject(new Error("no fetch")));
  assert.strictEqual(SB.enabled, false);
  await assert.rejects(() => SB.listVerifications(), /not configured/);
});

ok("createVerification POSTs a new row and asks for nothing back", async () => {
  let seen = null;
  const SB = makeSB(DEMO, (url, opts) => { seen = { url, opts }; return json(""); });
  const row = await SB.createVerification({ id: "node/1", status: "verified", verified_by: "Ahmed" });
  assert.strictEqual(row.id, "node/1");
  assert.strictEqual(row.status, "verified");
  assert.ok(seen.url.includes("/rest/v1/verifications"));
  assert.ok(!seen.url.includes("on_conflict"), "community INSERT, never an upsert");
  assert.strictEqual(seen.opts.method, "POST");
  assert.strictEqual(seen.opts.headers.apikey, "anon");
  assert.ok(seen.opts.headers.Prefer.includes("return=minimal"), "anon must not request the row back");
});

ok("updateVerification PATCHes by id with return=minimal (admin path)", async () => {
  let seen = null;
  const SB = makeSB(DEMO, (url, opts) => { seen = { url, opts }; return json(""); });
  await SB.updateVerification("node/1", { status: "closed" });
  assert.ok(seen.url.includes("id=eq.node" + encodeURIComponent("/1")));
  assert.strictEqual(seen.opts.method, "PATCH");
  const body = JSON.parse(seen.opts.body);
  assert.strictEqual(body.status, "closed");
  assert.ok(!("id" in body), "id is in the URL, not the body");
});

ok("deleteVerification issues DELETE by id", async () => {
  let seen = null;
  const SB = makeSB(DEMO, (url, opts) => { seen = { url, opts }; return json(""); });
  await SB.deleteVerification("node/1");
  assert.strictEqual(seen.opts.method, "DELETE");
  assert.ok(seen.url.includes("id=eq.node" + encodeURIComponent("/1")));
});

ok("upsertVerification tries INSERT first, escalates to UPDATE on 409", async () => {
  const calls = [];
  const SB = makeSB(DEMO, (url, opts) => {
    calls.push({ url, method: opts.method });
    if (opts.method === "POST") return json({ code: "23505", message: "duplicate key" }, 409);
    return json("");
  });
  const row = await SB.upsertVerification({ id: "node/1", status: "verified", verified_by: "A" });
  assert.strictEqual(row.id, "node/1");
  assert.ok(calls.some((c) => c.method === "POST"));
  assert.ok(calls.some((c) => c.method === "PATCH"), "escalated to admin UPDATE");
});

ok("createSubmission never sends status, asks for nothing back", async () => {
  let seen = null;
  const SB = makeSB(DEMO, (url, opts) => { seen = { url, opts }; return json(null); });
  const res = await SB.createSubmission({ name: "New Masjid", city: "Hamilton", lat: "-37.78", lon: "175.28", status: "approved" });
  assert.strictEqual(res.status, "pending");
  const body = JSON.parse(seen.opts.body);
  assert.ok(!("status" in body), "database forces pending; client sends no status");
  assert.strictEqual(body.lat, -37.78);
  assert.ok(seen.opts.headers.Prefer.includes("return=minimal"));
});

ok("updateSubmission PATCHes and deleteSubmission DELETEs (admin paths)", async () => {
  let sent = null;
  const SB = makeSB(DEMO, (url, opts) => { sent = { url, opts }; return json(null); });
  await SB.updateSubmission("uuid-1", { status: "approved" });
  assert.strictEqual(sent.opts.method, "PATCH");
  assert.ok(sent.url.includes("id=eq.uuid-1"));
  assert.strictEqual(JSON.parse(sent.opts.body).status, "approved");
  await SB.deleteSubmission("uuid-1");
  assert.strictEqual(sent.opts.method, "DELETE");
});

ok("RLS errors surface with status and body", async () => {
  const SB = makeSB(DEMO, () => json({ message: "new row violates row-level security policy", code: "42501" }, 401));
  try { await SB.createVerification({ id: "x", status: "verified" }); assert.fail("should throw"); }
  catch (e) { assert.strictEqual(e.status, 401); assert.ok(/row-level security/i.test(e.message)); }
});

ok("sign-in stores a session token and attaches it to requests", async () => {
  let authHeader = null;
  const SB = makeSB(DEMO, (url, opts) => {
    if (url.includes("/auth/v1/token")) return json({ access_token: "tok-123", user: { email: "a@b.c" } });
    authHeader = opts.headers.Authorization;
    return json([]);
  });
  await SB.signIn("admin@nz.nz", "secret");
  assert.strictEqual(SB.isSignedIn(), true);
  await SB.listSubmissions();
  assert.strictEqual(authHeader, "Bearer tok-123");
  SB.signOut();
  assert.strictEqual(SB.isSignedIn(), false);
});

ok("sign-in error surfaces the Supabase message", async () => {
  const SB = makeSB(DEMO, () => json({ error_description: "Invalid login credentials" }, 400));
  await assert.rejects(() => SB.signIn("a@b.c", "wrong"), /Invalid login credentials/);
});

(async () => {
  let good = 0;
  for (const t of pending) {
    try { await t.fn(); good += 1; console.log("  \u2713", t.name); }
    catch (e) { console.error("  \u2717", t.name, "\u2014", e.message); process.exitCode = 1; }
  }
  console.log("\n" + good + " checks passed (" + pending.length + " total)");
})();
