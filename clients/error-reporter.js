/**
 * Watchtower error reporter — drop this into any monitored project.
 *
 * Usage (in your app's entrypoint, BEFORE anything else):
 *   import { initWatchtower } from "./watchtower-error-reporter.js";
 *   initWatchtower({ slug: "hortus" });
 *
 * 50 lines of code. Zero dependencies. Batches + de-dupes client-side
 * so a rendering-loop error doesn't hammer the endpoint.
 */
const ENDPOINT = "https://YOUR-WATCHTOWER-PROJECT.supabase.co/functions/v1/ingest-error";

export function initWatchtower({ slug, endpoint = ENDPOINT, userId = null } = {}) {
  if (typeof window === "undefined") return;
  const seen = new Map(); // fingerprint -> last-sent-ms
  const DEDUP_MS = 60_000;

  function fingerprint(msg, stack) {
    return (msg + "|" + (stack || "").slice(0, 500)).slice(0, 600);
  }

  function report(message, stack) {
    if (!message) return;
    const fp = fingerprint(message, stack);
    const now = Date.now();
    if (seen.has(fp) && now - seen.get(fp) < DEDUP_MS) return;
    seen.set(fp, now);

    // Use sendBeacon when possible so it survives page unload
    const payload = JSON.stringify({
      slug, message: String(message).slice(0, 2000), stack: stack ?? null,
      url: location.href, user_agent: navigator.userAgent, user_id: userId,
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(endpoint, new Blob([payload], { type: "application/json" }));
      } else {
        fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: payload, keepalive: true });
      }
    } catch { /* never let the reporter itself break the page */ }
  }

  window.addEventListener("error", (e) => report(e.message, e.error?.stack));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    report(r?.message ?? String(r), r?.stack);
  });
  return { report };
}
