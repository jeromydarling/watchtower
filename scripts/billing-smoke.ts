/**
 * Watchtower — federation billing-path smoke test.
 *
 * Proves, with real signed live-mode events and zero dollars, that every
 * active satellite in the CROS hub's stripe_account_routing can actually
 * receive Stripe billing events end to end:
 *
 *   Stripe → hub stripe-hub-platform (signature) → router (metadata)
 *          → satellite stripe-in (federation HMAC) → satellite webhook (2xx)
 *
 * For each satellite it creates a $1/month subscription on a 3-day trial
 * (no payment method, no charge, auto-cancels if left behind), waits for the
 * hub's stripe_hub_events row to show a 2xx forward, cancels the
 * subscription, and checks the cancellation forwards too. Trial invoices
 * ($0 invoice.paid) double as a regression check on invoice routing.
 *
 * The 2026-08-21 run of this procedure (by hand) found two satellites that
 * would have silently eaten their first real payment: an undeployed target
 * function and a sync constructEvent that 400s everything in Deno. That is
 * the class of failure this exists to catch — deployment and configuration
 * state that no amount of reading the repo can verify.
 *
 * Env:
 *   CROS_STRIPE_SECRET_KEY      live key; restricted is fine (write:
 *                               customers, subscriptions, products, prices)
 *   CROS_HUB_SUPABASE_URL       defaults to the hub project URL
 *   CROS_HUB_SERVICE_ROLE_KEY   to read stripe_hub_events / resolve DLQ rows
 *   SATELLITE                   optional: probe just this slug
 *
 * Stripe fixtures are reused across runs via lookup_key
 * "watchtower-billing-smoke" — do not delete them in the dashboard; they are
 * inert between runs.
 */
import { createClient } from "@supabase/supabase-js";

const STRIPE_KEY = process.env.CROS_STRIPE_SECRET_KEY ?? "";
const HUB_URL = process.env.CROS_HUB_SUPABASE_URL ?? "https://zmeawjhxbgvtcfcfcygf.supabase.co";
const HUB_KEY = process.env.CROS_HUB_SERVICE_ROLE_KEY ?? "";
const ONLY = process.env.SATELLITE?.trim() || null;
const PURPOSE = "watchtower-billing-smoke";

if (!STRIPE_KEY || !HUB_KEY) {
  console.error("CROS_STRIPE_SECRET_KEY and CROS_HUB_SERVICE_ROLE_KEY are required.");
  process.exit(2);
}
if (STRIPE_KEY.includes("_test_")) {
  console.error("That is a test-mode key. The hub's endpoint is registered in live mode; a test key proves nothing here.");
  process.exit(2);
}

const hub = createClient(HUB_URL, HUB_KEY);
const runStart = new Date().toISOString();
const runId = `smoke-${Date.now()}`;

/** Stripe's form encoding for nested params: items[0][price]=..., metadata[k]=... */
function form(params: Record<string, unknown>, prefix = "", out: string[] = []): string[] {
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) v.forEach((item, i) => form(item as Record<string, unknown>, `${key}[${i}]`, out));
    else if (typeof v === "object") form(v as Record<string, unknown>, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function stripe(method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, unknown>) {
  const qs = method === "GET" && params ? `?${form(params).join("&")}` : "";
  const resp = await fetch(`https://api.stripe.com${path}${qs}`, {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" && params ? form(params).join("&") : undefined,
  });
  const body = await resp.json();
  if (!resp.ok) throw new Error(`Stripe ${method} ${path} → ${resp.status}: ${body?.error?.message ?? JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Fixtures: one price (by lookup_key) and one customer, reused forever ──
async function ensureFixtures(): Promise<{ priceId: string; customerId: string }> {
  const prices = await stripe("GET", "/v1/prices", { lookup_keys: [PURPOSE], limit: 1 });
  let priceId: string;
  if (prices.data.length) {
    priceId = prices.data[0].id;
    // Reactivate whatever a previous cleanup archived.
    if (!prices.data[0].active) await stripe("POST", `/v1/prices/${priceId}`, { active: true });
    const prod = await stripe("GET", `/v1/products/${prices.data[0].product}`);
    if (!prod.active) await stripe("POST", `/v1/products/${prod.id}`, { active: true });
  } else {
    const price = await stripe("POST", "/v1/prices", {
      unit_amount: 100,
      currency: "usd",
      recurring: { interval: "month" },
      lookup_key: PURPOSE,
      product_data: { name: "Watchtower billing-path probe (keep — reused by billing-smoke)" },
      metadata: { purpose: PURPOSE },
    });
    priceId = price.id;
  }

  const found = await stripe("GET", "/v1/customers/search", { query: `metadata['purpose']:'${PURPOSE}'`, limit: 1 });
  const customerId = found.data.length
    ? found.data[0].id
    : (await stripe("POST", "/v1/customers", {
        description: "Watchtower billing-path probe (keep — reused by billing-smoke)",
        metadata: { purpose: PURPOSE },
      })).id;

  return { priceId, customerId };
}

// ── The probe ─────────────────────────────────────────────────────────────
type Result = {
  satellite: string;
  created: "pass" | "fail" | "pending";
  deleted: "pass" | "fail" | "pending";
  invoice: "pass" | "fail" | "pending";
  detail: string[];
};

async function forwardsFor(satellite: string, eventType: string) {
  const { data, error } = await hub
    .from("stripe_hub_events")
    .select("forwarded_status_code, forwarded_response")
    .eq("satellite_app", satellite)
    .eq("event_type", eventType)
    .gte("routed_at", runStart)
    .order("routed_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`hub query failed: ${error.message}`);
  return data?.[0] ?? null;
}

async function main() {
  const { data: routes, error } = await hub
    .from("stripe_account_routing")
    .select("satellite_app, webhook_path, active")
    .eq("active", true)
    .eq("webhook_path", "stripe-in")
    .order("satellite_app");
  if (error) throw new Error(`routing query failed: ${error.message}`);

  let satellites = (routes ?? []).map((r) => r.satellite_app as string);
  if (ONLY) {
    if (!satellites.includes(ONLY)) {
      console.error(`Satellite "${ONLY}" is not active with webhook_path=stripe-in. Active: ${satellites.join(", ")}`);
      process.exit(2);
    }
    satellites = [ONLY];
  }
  console.log(`Probing ${satellites.length} satellite(s): ${satellites.join(", ")}`);
  console.log("(thecros and Cloudflare-hosted apps are excluded by design: they do not take the stripe-in path)");

  const { priceId, customerId } = await ensureFixtures();
  const results: Result[] = [];
  const subs = new Map<string, string>();

  // Create all probe subscriptions first, then poll — forwards land while we work.
  for (const satellite of satellites) {
    const r: Result = { satellite, created: "pending", deleted: "pending", invoice: "pending", detail: [] };
    results.push(r);
    try {
      const sub = await stripe("POST", "/v1/subscriptions", {
        customer: customerId,
        items: [{ price: priceId }],
        trial_period_days: 3,
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
        metadata: { satellite_app: satellite, purpose: PURPOSE, run_id: runId },
      });
      subs.set(satellite, sub.id);
    } catch (err) {
      r.created = "fail";
      r.detail.push(`subscription create failed: ${(err as Error).message}`);
    }
  }

  // Poll for created + invoice forwards (up to 2 minutes).
  const deadline1 = Date.now() + 120_000;
  while (Date.now() < deadline1) {
    let allSettled = true;
    for (const r of results) {
      if (!subs.has(r.satellite)) continue;
      if (r.created === "pending") {
        const row = await forwardsFor(r.satellite, "customer.subscription.created");
        if (row) {
          const ok = row.forwarded_status_code >= 200 && row.forwarded_status_code < 300;
          r.created = ok ? "pass" : "fail";
          if (!ok) r.detail.push(`created forward → ${row.forwarded_status_code}: ${String(row.forwarded_response).slice(0, 140)}`);
        }
      }
      if (r.invoice === "pending") {
        const row = await forwardsFor(r.satellite, "invoice.paid");
        if (row) {
          const ok = row.forwarded_status_code >= 200 && row.forwarded_status_code < 300;
          r.invoice = ok ? "pass" : "fail";
          if (!ok) r.detail.push(`invoice forward → ${row.forwarded_status_code}: ${String(row.forwarded_response).slice(0, 140)}`);
        }
      }
      if (r.created === "pending" || r.invoice === "pending") allSettled = false;
    }
    if (allSettled) break;
    await sleep(5000);
  }
  for (const r of results) {
    if (r.created === "pending") { r.created = "fail"; r.detail.push("no customer.subscription.created forward within 2min — event not routed (check hub endpoint + metadata)"); }
    if (r.invoice === "pending") { r.invoice = "fail"; r.detail.push("no invoice.paid forward within 2min — invoice routing regression (subscription_details metadata merge)"); }
  }

  // Cancel every probe subscription; poll the deletion forwards.
  for (const [satellite, subId] of subs) {
    try {
      await stripe("DELETE", `/v1/subscriptions/${subId}`);
    } catch (err) {
      const r = results.find((x) => x.satellite === satellite)!;
      r.deleted = "fail";
      r.detail.push(`cancel failed: ${(err as Error).message} — CANCEL sub ${subId} BY HAND`);
    }
  }
  const deadline2 = Date.now() + 120_000;
  while (Date.now() < deadline2) {
    let allSettled = true;
    for (const r of results) {
      if (!subs.has(r.satellite) || r.deleted !== "pending") continue;
      const row = await forwardsFor(r.satellite, "customer.subscription.deleted");
      if (row) {
        const ok = row.forwarded_status_code >= 200 && row.forwarded_status_code < 300;
        r.deleted = ok ? "pass" : "fail";
        if (!ok) r.detail.push(`deleted forward → ${row.forwarded_status_code}: ${String(row.forwarded_response).slice(0, 140)}`);
      } else allSettled = false;
    }
    if (allSettled) break;
    await sleep(5000);
  }
  for (const r of results) if (r.deleted === "pending") { r.deleted = "fail"; r.detail.push("no customer.subscription.deleted forward within 2min"); }

  // Archive the fixtures between runs so nothing sellable stays active.
  try {
    const price = (await stripe("GET", "/v1/prices", { lookup_keys: [PURPOSE], limit: 1 })).data[0];
    if (price) {
      await stripe("POST", `/v1/products/${price.product}`, { active: false, default_price: "" });
      await stripe("POST", `/v1/prices/${price.id}`, { active: false });
    }
  } catch (err) {
    console.warn(`fixture archive failed (harmless): ${(err as Error).message}`);
  }

  // Resolve DLQ rows this run created, matched by payload content — invoice
  // payloads carry no metadata, so match on the probe customer id too.
  try {
    const { data: open } = await hub
      .from("stripe_hub_dlq")
      .select("id, event_payload")
      .eq("resolved", false)
      .gte("created_at", runStart);
    const mine = (open ?? []).filter((row) => {
      const text = JSON.stringify(row.event_payload ?? {});
      return text.includes(PURPOSE) || text.includes(customerId);
    });
    if (mine.length) {
      await hub
        .from("stripe_hub_dlq")
        .update({ resolved: true, resolved_at: new Date().toISOString(), failure_reason: `resolved by billing-smoke ${runId}` })
        .in("id", mine.map((r) => r.id));
      console.log(`Resolved ${mine.length} DLQ row(s) created by this run.`);
    }
  } catch (err) {
    console.warn(`DLQ tidy-up failed (rows remain visible, not harmful): ${(err as Error).message}`);
  }

  // ── Report ──────────────────────────────────────────────────────────────
  const mark = (s: string) => (s === "pass" ? "✅" : "❌");
  const lines = [
    `## Billing-path smoke — ${new Date().toISOString().slice(0, 16)}Z`,
    "",
    "| Satellite | sub.created | invoice routed | sub.deleted | Notes |",
    "|---|---|---|---|---|",
    ...results.map((r) =>
      `| ${r.satellite} | ${mark(r.created)} | ${mark(r.invoice)} | ${mark(r.deleted)} | ${r.detail.join("; ") || "—"} |`),
  ];
  const report = lines.join("\n");
  console.log(`\n${report}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  }

  const failed = results.filter((r) => r.created !== "pass" || r.deleted !== "pass" || r.invoice !== "pass");
  if (failed.length) {
    console.error(`FAILED: ${failed.map((r) => r.satellite).join(", ")}`);
    process.exit(1);
  }
  console.log("All satellites green.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
