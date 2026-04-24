/**
 * Watchtower weekly audit digest.
 *
 * Runs every Monday at 14:17 UTC (9:17am CT).
 * Re-scans every repo in projects.json for the 10 silent-failure patterns
 * we originally identified during the audit and emails a summary.
 *
 * Patterns (ones we don't auto-fix nightly):
 *   1d: deprecated std (<0.190.0)
 *   1f: missing CORS headers
 *   1i: webhook missing verify_jwt=false
 *   1j: edge function > 50KB
 *
 * Writes an audit alert file with counts per repo so the email cron can
 * send a human-readable digest.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

type ScanResult = {
  repo: string;
  std_deprecated: number;
  missing_cors: number;
  webhook_no_verify_jwt: number;
  oversized: number;
  total_functions: number;
};

const CONFIG = JSON.parse(readFileSync(resolve(ROOT, "projects.json"), "utf-8")) as {
  projects: Project[];
};

const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.MONITORED_REPOS_TOKEN;
if (!GH_TOKEN) {
  console.error("GITHUB_TOKEN / MONITORED_REPOS_TOKEN required.");
  process.exit(2);
}

async function gh(path: string, opts: any = {}): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      "authorization": `Bearer ${GH_TOKEN}`,
      "accept": "application/vnd.github+json",
      "user-agent": "Watchtower/1.0",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`gh ${path}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function ghRaw(path: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      "authorization": `Bearer ${GH_TOKEN}`,
      "accept": "application/vnd.github.raw",
      "user-agent": "Watchtower/1.0",
    },
  });
  if (!res.ok) return null;
  return await res.text();
}

/** Walk a repo's supabase/functions/ tree and scan. */
async function scanRepo(repo: string): Promise<ScanResult> {
  const result: ScanResult = {
    repo,
    std_deprecated: 0,
    missing_cors: 0,
    webhook_no_verify_jwt: 0,
    oversized: 0,
    total_functions: 0,
  };

  const funcsIdx = await gh(`/repos/${repo}/contents/supabase/functions`);
  if (!Array.isArray(funcsIdx)) return result;

  // Load config.toml once to check verify_jwt settings
  const configToml = (await ghRaw(`/repos/${repo}/contents/supabase/config.toml`)) || "";
  const noVerifyJwtFns = new Set(
    Array.from(configToml.matchAll(/\[functions\.([^\]]+)\][^\[]*verify_jwt\s*=\s*false/g))
      .map((m) => m[1])
  );

  for (const entry of funcsIdx) {
    if (entry.type !== "dir") continue;
    const fnName = entry.name as string;
    if (fnName.startsWith("_") || ["shared", "utils", "utilities", "common", "tests"].includes(fnName.toLowerCase())) {
      continue;
    }
    result.total_functions++;

    const indexPath = `/repos/${repo}/contents/supabase/functions/${fnName}/index.ts`;
    const src = await ghRaw(indexPath);
    if (src == null) continue;

    // 1d: deprecated std
    const stdImports = [...src.matchAll(/https:\/\/deno\.land\/std@(\d+)\.(\d+)\.(\d+)\//g)];
    for (const m of stdImports) {
      const ver = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (ver[0] === 0 && (ver[1] < 190 || (ver[1] === 190 && ver[2] === 0 && false))) {
        result.std_deprecated++;
        break;
      }
    }

    // 1f: missing CORS (function has Deno.serve but no corsHeaders or Access-Control)
    const hasServe = /\b(serve|Deno\.serve)\s*\(/.test(src);
    const hasCors = /corsHeaders|Access-Control-Allow-Origin/.test(src);
    if (hasServe && !hasCors) {
      result.missing_cors++;
    }

    // 1i: webhook-ish name without verify_jwt = false
    const isWebhook = /webhook|-hook|stripe|notify|callback/i.test(fnName);
    if (isWebhook && !noVerifyJwtFns.has(fnName)) {
      result.webhook_no_verify_jwt++;
    }

    // 1j: file size > 50KB
    const sizeBytes = new Blob([src]).size;
    if (sizeBytes > 50 * 1024) {
      result.oversized++;
    }
  }

  return result;
}

async function main() {
  console.log(`Auditing ${CONFIG.projects.length} projects...`);

  // Dedupe repos (some projects share repos)
  const uniqueRepos = Array.from(new Set(CONFIG.projects.map((p) => p.repo)));
  const results: ScanResult[] = [];

  for (const repo of uniqueRepos) {
    console.log(`  scanning ${repo}...`);
    try {
      const r = await scanRepo(repo);
      results.push(r);
      console.log(`    std=${r.std_deprecated} cors=${r.missing_cors} webhooks=${r.webhook_no_verify_jwt} big=${r.oversized}/${r.total_functions}`);
    } catch (e: any) {
      console.error(`    ERROR: ${e.message}`);
    }
  }

  const totals = results.reduce((acc, r) => ({
    std_deprecated: acc.std_deprecated + r.std_deprecated,
    missing_cors: acc.missing_cors + r.missing_cors,
    webhook_no_verify_jwt: acc.webhook_no_verify_jwt + r.webhook_no_verify_jwt,
    oversized: acc.oversized + r.oversized,
    total_functions: acc.total_functions + r.total_functions,
  }), { std_deprecated: 0, missing_cors: 0, webhook_no_verify_jwt: 0, oversized: 0, total_functions: 0 });

  const topOffenders = results
    .map((r) => ({ repo: r.repo, total: r.std_deprecated + r.missing_cors + r.webhook_no_verify_jwt + r.oversized }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const narrative = [
    `Weekly Watchtower audit scan of ${uniqueRepos.length} repositories, ${totals.total_functions} edge functions.`,
    ``,
    `Findings across all repos (patterns 1d/1f/1i/1j):`,
    `  • Deprecated std<0.190.0 imports: ${totals.std_deprecated}`,
    `  • Functions missing CORS headers: ${totals.missing_cors}`,
    `  • Webhooks missing verify_jwt=false: ${totals.webhook_no_verify_jwt}`,
    `  • Functions > 50KB (cold-start risk): ${totals.oversized}`,
    ``,
    topOffenders.length
      ? `Top offenders: ${topOffenders.map((o) => `${o.repo} (${o.total})`).join(", ")}.`
      : `No offenders this week. Great work.`,
    ``,
    `Dashboard: https://jeromydarling.github.io/watchtower/`,
  ].join("\n");

  mkdirSync(resolve(ROOT, "alerts/outbox"), { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(resolve(ROOT, `alerts/outbox/${ts}-_audit-digest.json`), JSON.stringify({
    kind: "audit_digest",
    project: {
      name: "Watchtower Audit",
      slug: "_audit_digest",
      repo: "jeromydarling/watchtower",
      critical: false,
      health_url: "",
    },
    prev_status: null,
    current: { status: "ok", checks: totals },
    narrative,
    urgent: false,
    details: { results, totals, top_offenders: topOffenders },
  }, null, 2));

  // Persist history
  mkdirSync(resolve(ROOT, "audit-history"), { recursive: true });
  writeFileSync(
    resolve(ROOT, `audit-history/${new Date().toISOString().slice(0, 10)}.json`),
    JSON.stringify({ ts: new Date().toISOString(), totals, results }, null, 2)
  );

  console.log("Audit digest written.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
