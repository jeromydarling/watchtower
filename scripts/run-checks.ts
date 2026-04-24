/**
 * Watchtower — main check loop.
 *
 * Runs every 5 minutes via GitHub Actions.
 * For each project in projects.json:
 *   1. Ping its health_url (any 2xx = ok, or Watchtower /health JSON shape if present)
 *   2. Verify DNS resolves for its hostname
 *   3. Inspect its TLS cert and flag if expiring soon (< 14 days)
 *   4. Fetch /version if present, otherwise latest GitHub commit timestamp
 *   5. Record everything to Supabase
 *   6. If health status flipped, drop an alert file for the email cron
 *   7. Rebuild public/status.json so the dashboard stays fresh
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promises as dns } from "node:dns";
import tls from "node:tls";

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
  // New in phase 2
  dns_ok: boolean | null;
  dns_error: string | null;
  ssl_days_until_expiry: number | null;
  ssl_issuer: string | null;
  ssl_error: string | null;
  last_deploy_at: string | null;
  last_deploy_source: string | null;   // "version_endpoint" | "github" | null
};

const CONFIG = JSON.parse(readFileSync(resolve(ROOT, "projects.json"), "utf-8")) as {
  projects: Project[];
};

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.MONITORED_REPOS_TOKEN || "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(2);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** Resolve DNS A record for a hostname. */
async function checkDns(hostname: string): Promise<{ ok: boolean; error: string | null }> {
  try {
    const addrs = await dns.resolve4(hostname);
    return { ok: addrs.length > 0, error: null };
  } catch (err: any) {
    // Fall back to any resolve (AAAA, CNAME-chased)
    try {
      await dns.lookup(hostname);
      return { ok: true, error: null };
    } catch (err2: any) {
      return { ok: false, error: err2.code || err2.message || String(err2) };
    }
  }
}

/** Inspect TLS cert and return days until expiry. */
async function checkSsl(hostname: string): Promise<{
  days: number | null;
  issuer: string | null;
  error: string | null;
}> {
  return new Promise((resolveP) => {
    const timer = setTimeout(() => {
      try { socket.destroy(); } catch {}
      resolveP({ days: null, issuer: null, error: "TLS handshake timeout" });
    }, 8000);
    const socket = tls.connect({
      host: hostname,
      port: 443,
      servername: hostname,
      rejectUnauthorized: false, // we want to INSPECT even invalid certs
    }, () => {
      try {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) {
          clearTimeout(timer);
          socket.end();
          return resolveP({ days: null, issuer: null, error: "No certificate returned" });
        }
        const expiry = new Date(cert.valid_to).getTime();
        const days = Math.floor((expiry - Date.now()) / (24 * 60 * 60 * 1000));
        const issuer = cert.issuer?.O || cert.issuer?.CN || null;
        clearTimeout(timer);
        socket.end();
        resolveP({ days, issuer, error: null });
      } catch (err: any) {
        clearTimeout(timer);
        try { socket.destroy(); } catch {}
        resolveP({ days: null, issuer: null, error: err.message || String(err) });
      }
    });
    socket.on("error", (err: any) => {
      clearTimeout(timer);
      resolveP({ days: null, issuer: null, error: err.code || err.message || String(err) });
    });
  });
}

/** Try /version on the same origin as health_url. */
async function tryVersionEndpoint(healthUrl: string): Promise<{
  deployed_at: string | null;
  version: string | null;
}> {
  try {
    const u = new URL(healthUrl);
    const versionUrl = `${u.origin}/version`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(versionUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { deployed_at: null, version: null };
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      return {
        deployed_at: j.deployed_at || j.deployedAt || j.timestamp || null,
        version: j.version || j.sha || j.commit || null,
      };
    } catch {
      return { deployed_at: null, version: null };
    }
  } catch {
    return { deployed_at: null, version: null };
  }
}

/** Fall back to GitHub's latest commit on main. */
async function githubLatestCommit(repo: string): Promise<string | null> {
  if (!repo) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/commits?per_page=1&sha=main`,
      {
        headers: {
          "user-agent": "Watchtower/1.0",
          "accept": "application/vnd.github+json",
          ...(GITHUB_TOKEN ? { "authorization": `Bearer ${GITHUB_TOKEN}` } : {}),
        },
      }
    );
    if (!res.ok) return null;
    const arr = await res.json() as any[];
    return arr?.[0]?.commit?.author?.date || arr?.[0]?.commit?.committer?.date || null;
  } catch {
    return null;
  }
}

async function checkOne(p: Project): Promise<CheckResult> {
  const now = new Date().toISOString();
  const base: CheckResult = {
    slug: p.slug, name: p.name, status: "unconfigured",
    http_status: null, latency_ms: null, checks: {}, version: null,
    error: null, checked_at: now,
    dns_ok: null, dns_error: null,
    ssl_days_until_expiry: null, ssl_issuer: null, ssl_error: null,
    last_deploy_at: null, last_deploy_source: null,
  };

  if (!p.health_url) {
    // Even unconfigured projects get last_deploy from GitHub
    base.last_deploy_at = await githubLatestCommit(p.repo);
    if (base.last_deploy_at) base.last_deploy_source = "github";
    base.error = "No health_url configured";
    return base;
  }

  const hostname = new URL(p.health_url).hostname;

  // Fire DNS + SSL + HTTP + version checks in parallel
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  const start = Date.now();
  const httpPromise = fetch(p.health_url, {
    signal: ctrl.signal,
    headers: { "user-agent": "Watchtower/1.0 (+https://github.com/jeromydarling/watchtower)" },
  }).then(async (res) => {
    const latency = Date.now() - start;
    const text = await res.text();
    let body: HealthResp | null = null;
    try { body = JSON.parse(text) as HealthResp; } catch { /* non-JSON body */ }
    return { res, latency, body };
  });

  const [dnsRes, sslRes, versionRes, httpRes] = await Promise.all([
    checkDns(hostname).catch((e) => ({ ok: false, error: String(e) })),
    checkSsl(hostname).catch((e) => ({ days: null, issuer: null, error: String(e) })),
    tryVersionEndpoint(p.health_url).catch(() => ({ deployed_at: null, version: null })),
    httpPromise.catch((err: any) => ({ err } as any)),
  ]);
  clearTimeout(timer);

  base.dns_ok = dnsRes.ok;
  base.dns_error = dnsRes.error;
  base.ssl_days_until_expiry = sslRes.days;
  base.ssl_issuer = sslRes.issuer;
  base.ssl_error = sslRes.error;

  // Deploy tracking: prefer /version, fall back to GitHub
  if (versionRes.deployed_at) {
    base.last_deploy_at = versionRes.deployed_at;
    base.last_deploy_source = "version_endpoint";
  } else {
    base.last_deploy_at = await githubLatestCommit(p.repo);
    if (base.last_deploy_at) base.last_deploy_source = "github";
  }

  if ("err" in httpRes && httpRes.err) {
    base.status = "down";
    base.latency_ms = Date.now() - start;
    base.error = httpRes.err?.name === "AbortError"
      ? "Timed out after 10s"
      : (httpRes.err?.message ?? String(httpRes.err));
    return base;
  }

  const { res, latency, body } = httpRes as any;
  const hasHealthShape = body && typeof body.status === "string";
  const httpStatus: CheckResult["status"] = hasHealthShape
    ? (res.ok && body.status === "ok" ? "ok"
      : res.ok && body.status === "degraded" ? "degraded"
      : "down")
    : (res.ok ? "ok" : "down");

  base.status = httpStatus;
  base.http_status = res.status;
  base.latency_ms = latency;
  base.checks = body?.checks ?? {};
  base.version = versionRes.version ?? body?.version ?? null;
  base.error = res.ok ? null : `HTTP ${res.status}`;

  return base;
}

/** URL to this project's runbook inside the watchtower repo. */
function runbookUrl(slug: string): string {
  return `https://github.com/jeromydarling/watchtower/blob/main/runbooks/${slug}.md`;
}

/** Build a plain-English summary of the change for the email. */
function humanize(p: Project, prev: string | null, curr: CheckResult): string {
  const when = new Date(curr.checked_at).toLocaleString("en-US", {
    timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short",
  });
  const runbook = `Runbook: ${runbookUrl(p.slug)}`;
  if (prev === "ok" && curr.status !== "ok") {
    const reason = curr.error ?? "the health check reported it is not ok";
    const failing = Object.entries(curr.checks).filter(([, v]) => v !== "ok");
    const detail = failing.length
      ? `Failing subsystems: ${failing.map(([k, v]) => `${k} (${v})`).join(", ")}.`
      : "";
    const sslWarning = curr.ssl_days_until_expiry !== null && curr.ssl_days_until_expiry < 14
      ? `Heads up: TLS cert expires in ${curr.ssl_days_until_expiry} days.`
      : "";
    const deployContext = curr.last_deploy_at
      ? `Last deploy: ${new Date(curr.last_deploy_at).toLocaleString("en-US", { timeZone: "America/Chicago" })} Central (${curr.last_deploy_source}).`
      : "";
    return [
      `${p.name} just went down.`,
      `Watchtower tried to reach it at ${when} Central and got: ${reason}.`,
      detail,
      sslWarning,
      deployContext,
      p.critical ? "This is a TIER 1 project." : "This project is tier 2.",
      runbook,
      `Repo: https://github.com/${p.repo}`,
    ].filter(Boolean).join("\n\n");
  }
  if (prev !== "ok" && curr.status === "ok") {
    return `${p.name} is back up as of ${when} Central. No action needed.`;
  }
  return [
    `${p.name} status changed from ${prev ?? "unknown"} to ${curr.status} at ${when} Central.`,
    runbook,
  ].join("\n\n");
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
      dns_ok: r.dns_ok,
      ssl_days_until_expiry: r.ssl_days_until_expiry,
      last_deploy_at: r.last_deploy_at,
    }))
  );
  if (insErr) console.error("Failed to insert checks:", insErr.message);

  // 2) Compare against the most recent prior status per slug
  const { data: prev } = await sb
    .from("current_status")
    .select("slug,status,ssl_days_until_expiry");
  const prevMap = new Map((prev ?? []).map((r: any) => [r.slug, r]));

  mkdirSync(resolve(ROOT, "alerts/outbox"), { recursive: true });
  const outboxExisting = new Set(readdirSync(resolve(ROOT, "alerts/outbox")));

  const flips: Array<{ project: Project; prev: string | null; curr: CheckResult }> = [];
  for (const r of results) {
    const p = CONFIG.projects.find((x) => x.slug === r.slug)!;
    const prevRec = prevMap.get(r.slug) as any | undefined;
    const previousStatus: string | null = prevRec?.status ?? null;
    const prevSslDays: number | null = prevRec?.ssl_days_until_expiry ?? null;

    const isStatusFlip =
      (previousStatus === "ok" && r.status !== "ok" && r.status !== "unconfigured") ||
      (previousStatus && previousStatus !== "ok" && r.status === "ok");

    // New: SSL expiry alert — fires once when cert first crosses under 14 days
    const isSslFlip =
      r.ssl_days_until_expiry !== null &&
      r.ssl_days_until_expiry < 14 &&
      r.ssl_days_until_expiry >= 0 &&
      (prevSslDays === null || prevSslDays >= 14);

    if (isStatusFlip) {
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

    if (isSslFlip) {
      const fname = `${r.checked_at.replace(/[:.]/g, "-")}-${r.slug}-ssl-expiring.json`;
      if (!outboxExisting.has(fname)) {
        writeFileSync(resolve(ROOT, "alerts/outbox", fname), JSON.stringify({
          kind: "ssl_expiring",
          project: p,
          prev_status: previousStatus,
          current: r,
          narrative: `${p.name}'s TLS certificate expires in ${r.ssl_days_until_expiry} days (issuer: ${r.ssl_issuer ?? "unknown"}). Renew before expiry to avoid downtime.`,
          urgent: p.critical,
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
      dns_ok: r.dns_ok,
      ssl_days_until_expiry: r.ssl_days_until_expiry,
      ssl_issuer: r.ssl_issuer,
      last_deploy_at: r.last_deploy_at,
      last_deploy_source: r.last_deploy_source,
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
          dns_ok: r.dns_ok,
          ssl_days_until_expiry: r.ssl_days_until_expiry,
          ssl_issuer: r.ssl_issuer,
          last_deploy_at: r.last_deploy_at,
          last_deploy_source: r.last_deploy_source,
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
