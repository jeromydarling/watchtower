/**
 * Watchtower — main check loop.
 *
 * Runs every 5 minutes via GitHub Actions.
 * For each project in projects.json:
 *   1. Hit its /health endpoint with a 10s timeout
 *   2. Record the result in Supabase
 *   3. If the status flipped (healthy <-> unhealthy), drop an alert file
 *      in alerts/outbox/ so the Computer task can email it
 *   4. Rebuild public/status.json so the dashboard stays fresh
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

type Project = {
  name: string;
  slug: string;
  repo: string;
  health_url: string;
  critical: boolean;
};

type HealthResp = {
  status: "ok" | "degraded" | "down";
  checks?: Record<string, "ok" | "degraded" | "down" | string>;
  version?: string;
  timestamp?: string;
};

type CheckResult = {
  slug: string;
  name: string;
  status: "ok" | "degraded" | "down" | "unconfigured";
  http_status: number | null;
  latency_ms: number | null;
  checks: Record<string, string>;
  version: string | null;
  error: string | null;
  checked_at: string;
};

const CONFIG = JSON.parse(readFileSync(resolve(ROOT, "projects.json"), "utf-8")) as {
  projects: Project[];
};

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(2);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function checkOne(p: Project): Promise<CheckResult> {
  const now = new Date().toISOString();
  if (!p.health_url) {
    return {
      slug: p.slug, name: p.name, status: "unconfigured",
      http_status: null, latency_ms: null, checks: {}, version: null,
      error: "No health_url configured", checked_at: now,
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  const start = Date.now();
  try {
    const res = await fetch(p.health_url, {
      signal: ctrl.signal,
      headers: { "user-agent": "Watchtower/1.0 (+https://github.com/jeromydarling/watchtower)" },
    });
    const latency = Date.now() - start;
    const text = await res.text();
    let body: HealthResp | null = null;
    try { body = JSON.parse(text) as HealthResp; } catch { /* non-JSON body */ }

    const status: CheckResult["status"] =
      res.ok && body?.status === "ok" ? "ok" :
      res.ok && body?.status === "degraded" ? "degraded" :
      "down";

    return {
      slug: p.slug, name: p.name, status,
      http_status: res.status, latency_ms: latency,
      checks: body?.checks ?? {}, version: body?.version ?? null,
      error: res.ok ? null : `HTTP ${res.status}`,
      checked_at: now,
    };
  } catch (err: any) {
    return {
      slug: p.slug, name: p.name, status: "down",
      http_status: null, latency_ms: Date.now() - start,
      checks: {}, version: null,
      error: err?.name === "AbortError" ? "Timed out after 10s" : (err?.message ?? String(err)),
      checked_at: now,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Build a plain-English summary of the change for the email. */
function humanize(p: Project, prev: string | null, curr: CheckResult): string {
  const when = new Date(curr.checked_at).toLocaleString("en-US", {
    timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short",
  });
  if (prev === "ok" && curr.status !== "ok") {
    const reason = curr.error ?? "the health check reported it is not ok";
    const failing = Object.entries(curr.checks).filter(([, v]) => v !== "ok");
    const detail = failing.length
      ? `Failing subsystems: ${failing.map(([k, v]) => `${k} (${v})`).join(", ")}.`
      : "";
    return [
      `${p.name} just went down.`,
      `Watchtower tried to reach it at ${when} Central and got: ${reason}.`,
      detail,
      p.critical ? "This is a CRITICAL project." : "This project is marked non-critical.",
      `Repo: https://github.com/${p.repo}`,
    ].filter(Boolean).join("\n\n");
  }
  if (prev !== "ok" && curr.status === "ok") {
    return `${p.name} is back up as of ${when} Central. No action needed.`;
  }
  return `${p.name} status changed from ${prev ?? "unknown"} to ${curr.status} at ${when} Central.`;
}

async function main() {
  console.log(`Watchtower check loop starting — ${CONFIG.projects.length} projects`);

  const results = await Promise.all(CONFIG.projects.map(checkOne));

  // 1) Persist every check
  const { error: insErr } = await sb.from("checks").insert(
    results.map((r) => ({
      slug: r.slug,
      status: r.status,
      http_status: r.http_status,
      latency_ms: r.latency_ms,
      checks: r.checks,
      version: r.version,
      error: r.error,
      checked_at: r.checked_at,
    }))
  );
  if (insErr) console.error("Failed to insert checks:", insErr.message);

  // 2) Compare against the most recent prior status per slug
  const { data: prev } = await sb
    .from("current_status")
    .select("slug,status");
  const prevMap = new Map((prev ?? []).map((r: any) => [r.slug, r.status]));

  mkdirSync(resolve(ROOT, "alerts/outbox"), { recursive: true });
  const outboxExisting = new Set(readdirSync(resolve(ROOT, "alerts/outbox")));

  const flips: Array<{ project: Project; prev: string | null; curr: CheckResult }> = [];
  for (const r of results) {
    const p = CONFIG.projects.find((x) => x.slug === r.slug)!;
    const previousStatus = prevMap.get(r.slug) ?? null;
    const isFlip =
      (previousStatus === "ok" && r.status !== "ok" && r.status !== "unconfigured") ||
      (previousStatus && previousStatus !== "ok" && r.status === "ok");
    if (isFlip) {
      flips.push({ project: p, prev: previousStatus, curr: r });
      const fname = `${r.checked_at.replace(/[:.]/g, "-")}-${r.slug}-${r.status}.json`;
      if (!outboxExisting.has(fname)) {
        writeFileSync(resolve(ROOT, "alerts/outbox", fname), JSON.stringify({
          kind: previousStatus === "ok" ? "incident_opened" : "incident_resolved",
          project: p,
          prev_status: previousStatus,
          current: r,
          narrative: humanize(p, previousStatus, r),
          urgent: p.critical && previousStatus === "ok" && r.status !== "ok",
        }, null, 2));
      }
    }
  }

  // 3) Upsert current_status for each slug
  const { error: upErr } = await sb.from("current_status").upsert(
    results.map((r) => ({
      slug: r.slug,
      status: r.status,
      last_checked_at: r.checked_at,
      last_latency_ms: r.latency_ms,
      last_error: r.error,
    })),
    { onConflict: "slug" }
  );
  if (upErr) console.error("Failed to upsert current_status:", upErr.message);

  // 4) Build public/status.json (dashboard reads this)
  const { data: uptime } = await sb.rpc("uptime_summary");
  const uptimeMap = new Map((uptime ?? []).map((u: any) => [u.slug, u]));

  const dashboard = {
    generated_at: new Date().toISOString(),
    projects: results.map((r) => {
      const p = CONFIG.projects.find((x) => x.slug === r.slug)!;
      const u = uptimeMap.get(r.slug) as any;
      return {
        name: p.name,
        slug: p.slug,
        repo: p.repo,
        critical: p.critical,
        health_url: p.health_url || null,
        current: {
          status: r.status,
          latency_ms: r.latency_ms,
          error: r.error,
          checked_at: r.checked_at,
          checks: r.checks,
          version: r.version,
        },
        uptime: {
          last_24h: u?.uptime_24h ?? null,
          last_7d: u?.uptime_7d ?? null,
          last_30d: u?.uptime_30d ?? null,
          incidents_7d: u?.incidents_7d ?? 0,
        },
      };
    }),
  };
  mkdirSync(resolve(ROOT, "public"), { recursive: true });
  writeFileSync(resolve(ROOT, "public/status.json"), JSON.stringify(dashboard, null, 2));

  console.log(`Done. ${flips.length} state change(s) this run.`);
  for (const f of flips) {
    console.log(`  ${f.prev ?? "new"} → ${f.curr.status}  ${f.project.name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
