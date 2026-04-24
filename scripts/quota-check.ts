/**
 * Watchtower quota check — runs once a day.
 *
 * Queries the Watchtower Supabase DB for:
 *   - Total rows in each table
 *   - Approx database size
 *   - Days of history retained
 * And drops an alert if any of these cross warning thresholds.
 *
 * Supabase free tier limits as of 2026:
 *   - Database: 500 MB
 *   - Row limit: effectively ~10M with soft throttling
 *   - Edge function invocations: 500k/month
 *
 * We warn at 70%, alert at 90%.
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_PAT = process.env.SUPABASE_PAT ?? "";
const PROJECT_REF = process.env.WATCHTOWER_SUPABASE_REF ?? "mgtbbveeqnpbesfmtkng";

const DB_QUOTA_MB = 500; // free tier
const WARN_PCT = 70;
const ALERT_PCT = 90;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** Run a raw SQL query via Management API (requires sbp_ PAT). */
async function pgQuery(sql: string): Promise<any[]> {
  if (!SUPABASE_PAT) throw new Error("SUPABASE_PAT not set");
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        "authorization": `Bearer ${SUPABASE_PAT}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    }
  );
  if (!res.ok) throw new Error(`pgQuery failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function main() {
  console.log("Watchtower quota check");

  const sizeRows = await pgQuery(`
    SELECT
      pg_database_size(current_database()) / 1024 / 1024.0 AS db_size_mb,
      (SELECT count(*) FROM public.checks) AS checks_rows,
      (SELECT count(*) FROM public.errors) AS errors_rows,
      (SELECT count(*) FROM public.current_status) AS current_status_rows,
      (SELECT max(checked_at) FROM public.checks) AS newest_check,
      (SELECT min(checked_at) FROM public.checks) AS oldest_check
  `);

  const m = sizeRows[0] ?? {};
  const dbMb = Number(m.db_size_mb ?? 0);
  const pct = (dbMb / DB_QUOTA_MB) * 100;

  console.log(`DB size: ${dbMb.toFixed(1)} MB / ${DB_QUOTA_MB} MB (${pct.toFixed(1)}%)`);
  console.log(`  checks rows:         ${m.checks_rows}`);
  console.log(`  errors rows:         ${m.errors_rows}`);
  console.log(`  current_status rows: ${m.current_status_rows}`);
  console.log(`  oldest check:        ${m.oldest_check}`);
  console.log(`  newest check:        ${m.newest_check}`);

  // Auto-prune: keep only last 30 days of checks (uptime_summary only looks at 30d)
  const prunedRows = await pgQuery(`
    WITH deleted AS (
      DELETE FROM public.checks
      WHERE checked_at < now() - interval '30 days'
      RETURNING 1
    )
    SELECT count(*) AS removed FROM deleted
  `);
  const pruned = Number(prunedRows[0]?.removed ?? 0);
  console.log(`Pruned ${pruned} checks older than 30 days.`);

  // Persist a snapshot so we have history
  await sb.from("checks").insert({
    slug: "_watchtower_quota",
    status: pct > ALERT_PCT ? "down" : pct > WARN_PCT ? "degraded" : "ok",
    http_status: null,
    latency_ms: null,
    checks: { db_mb: dbMb.toFixed(1), pct: pct.toFixed(1) },
    version: String(pruned),
    error: null,
  });

  // Drop an alert if we've crossed a threshold
  if (pct > ALERT_PCT) {
    mkdirSync(resolve(ROOT, "alerts/outbox"), { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(resolve(ROOT, `alerts/outbox/${ts}-_watchtower-quota-alert.json`), JSON.stringify({
      kind: "quota_alert",
      project: { name: "Watchtower itself", slug: "_watchtower_quota", repo: "jeromydarling/watchtower", critical: true, health_url: "" },
      current: { status: "down", error: `DB at ${pct.toFixed(1)}% of ${DB_QUOTA_MB} MB quota` },
      prev_status: null,
      narrative: `Watchtower's own Supabase DB is at ${dbMb.toFixed(1)} MB (${pct.toFixed(1)}% of ${DB_QUOTA_MB} MB free-tier quota). Prune old checks, upgrade the Supabase project, or reduce check retention.`,
      urgent: true,
    }, null, 2));
    console.log("ALERT DROPPED: DB quota exceeded");
  } else if (pct > WARN_PCT) {
    console.log(`WARN: DB at ${pct.toFixed(1)}% — watch this.`);
  } else {
    console.log("DB quota healthy.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
