/**
 * Watchtower triage — turn raw client errors into one of four lanes.
 *
 *   auto_fix         → mark for the next auto-fix sweep (sweep does the work)
 *   needs_approval   → file a GitHub issue with a fix recipe; thumbs-up to approve
 *   manual           → file a GitHub issue explaining why we can't auto-fix
 *   unmatched        → no rule matched yet; leaves it for a human to label
 *
 * Runs every check cycle. Idempotent: skips fingerprints already triaged.
 *
 * Logs every decision to activity_log so the dashboard can show a feed.
 */
import { createClient } from "@supabase/supabase-js";
import { Octokit } from "@octokit/rest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CONFIG = JSON.parse(readFileSync(resolve(ROOT, "projects.json"), "utf8"));
const PROJECT_INDEX = new Map<string, any>(CONFIG.projects.map((p: any) => [p.slug, p]));

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GH_TOKEN = process.env.GITHUB_TOKEN!;
const WATCHTOWER_REPO = "jeromydarling/watchtower";

if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required");
if (!GH_TOKEN) throw new Error("GITHUB_TOKEN required");

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const gh = new Octokit({ auth: GH_TOKEN });

interface Rule {
  id: number;
  pattern: string;
  lane: "auto_fix" | "needs_approval" | "manual";
  fix_recipe: string | null;
  reason: string;
}

interface ErrorRow {
  slug: string;
  fingerprint: string;
  message: string;
  count: number;
  last_seen_at: string;
}

async function logActivity(args: {
  actor: string;
  action: string;
  slug?: string;
  fingerprint?: string;
  summary: string;
  github_url?: string;
}) {
  const { error } = await sb.from("activity_log").insert(args);
  if (error) console.error("activity_log insert failed:", error.message);
}

function findMatch(message: string, rules: Rule[]): Rule | null {
  for (const r of rules) {
    try {
      if (new RegExp(r.pattern, "i").test(message)) return r;
    } catch {
      // bad regex — skip silently rather than crash the run
    }
  }
  return null;
}

async function fileApprovalIssue(err: ErrorRow, rule: Rule, project: any): Promise<string> {
  const title = `[approve] ${project.name}: ${err.message.slice(0, 80)}${err.message.length > 80 ? "…" : ""}`;
  const body = [
    `Watchtower wants to ship a fix for an error spiking on **${project.name}**. React 👍 to approve, 👎 to dismiss.`,
    "",
    `**Slug:** \`${err.slug}\`  |  **Fingerprint:** \`${err.fingerprint}\``,
    `**Occurrences (24h):** ${err.count}  |  **Last seen:** ${err.last_seen_at}`,
    "",
    "**Error message:**",
    "```",
    err.message,
    "```",
    "",
    `**Why this needs approval:** ${rule.reason}`,
    `**Proposed fix recipe:** \`${rule.fix_recipe ?? "(none — needs human author)"}\``,
    "",
    `Repo: https://github.com/${project.repo}`,
    `Runbook: https://github.com/${WATCHTOWER_REPO}/blob/main/runbooks/${err.slug}.md`,
    "",
    "_Filed automatically by Watchtower. Approval poller checks this issue every 15 min._",
  ].join("\n");

  const { data: issue } = await gh.issues.create({
    owner: "jeromydarling", repo: "watchtower",
    title, body, labels: ["watchtower", "needs-approval", err.slug],
  });
  return issue.html_url;
}

async function fileManualIssue(err: ErrorRow, rule: Rule, project: any): Promise<string> {
  const title = `[manual] ${project.name}: ${err.message.slice(0, 80)}${err.message.length > 80 ? "…" : ""}`;
  const body = [
    `Watchtower can't fix this one automatically. **${project.name}** needs your attention.`,
    "",
    `**Slug:** \`${err.slug}\`  |  **Fingerprint:** \`${err.fingerprint}\``,
    `**Occurrences (24h):** ${err.count}  |  **Last seen:** ${err.last_seen_at}`,
    "",
    "**Error message:**",
    "```",
    err.message,
    "```",
    "",
    `**Why this is manual:** ${rule.reason}`,
    "",
    `Repo: https://github.com/${project.repo}`,
    `Runbook: https://github.com/${WATCHTOWER_REPO}/blob/main/runbooks/${err.slug}.md`,
    "",
    "_Close this issue when you've fixed it. Watchtower will mark it resolved._",
  ].join("\n");

  const { data: issue } = await gh.issues.create({
    owner: "jeromydarling", repo: "watchtower",
    title, body, labels: ["watchtower", "manual", err.slug],
  });
  return issue.html_url;
}

async function main() {
  console.log("Watchtower triage starting");

  const { data: rulesRaw } = await sb.from("triage_rules").select("*").eq("enabled", true);
  const rules = (rulesRaw ?? []) as Rule[];
  console.log(`  loaded ${rules.length} triage rules`);

  // Pull recent errors that haven't been triaged yet.
  const { data: existingDecisions } = await sb.from("triage_decisions").select("slug, fingerprint");
  const seen = new Set((existingDecisions ?? []).map((d: any) => `${d.slug}|${d.fingerprint}`));

  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const { data: errs } = await sb
    .from("errors")
    .select("slug, fingerprint, message, count, last_seen_at")
    .gte("last_seen_at", since)
    .order("last_seen_at", { ascending: false });

  let filed = 0, autofix = 0, manual = 0, unmatched = 0;

  for (const err of (errs ?? []) as ErrorRow[]) {
    const key = `${err.slug}|${err.fingerprint}`;
    if (seen.has(key)) continue;

    const project = PROJECT_INDEX.get(err.slug);
    if (!project) continue; // error from an unknown slug — leave it alone

    const rule = findMatch(err.message, rules);
    let lane: string = "unmatched";
    let prUrl: string | null = null;
    let issueUrl: string | null = null;

    if (rule) {
      lane = rule.lane;
      if (rule.lane === "needs_approval") {
        issueUrl = await fileApprovalIssue(err, rule, project);
        filed++;
      } else if (rule.lane === "manual") {
        issueUrl = await fileManualIssue(err, rule, project);
        manual++;
      } else if (rule.lane === "auto_fix") {
        autofix++;
        // No artifact yet — the auto-fix sweep picks it up via the decision row.
      }
    } else {
      unmatched++;
      lane = "unmatched";
    }

    await sb.from("triage_decisions").insert({
      slug: err.slug,
      fingerprint: err.fingerprint,
      lane,
      fix_recipe: rule?.fix_recipe ?? null,
      rule_id: rule?.id ?? null,
      pr_url: prUrl,
      issue_url: issueUrl,
      status: lane === "auto_fix" ? "approved" : "open", // auto_fix is pre-approved
    });

    await logActivity({
      actor: "watchtower-bot",
      action: lane === "needs_approval"
        ? "filed_approval_request"
        : lane === "manual"
          ? "filed_manual_issue"
          : lane === "auto_fix"
            ? "queued_for_autofix"
            : "triaged_unmatched",
      slug: err.slug,
      fingerprint: err.fingerprint,
      summary: rule
        ? `${project.name}: ${rule.reason.split(".")[0]}.`
        : `${project.name}: new error pattern, no rule matched.`,
      github_url: issueUrl ?? undefined,
    });
  }

  console.log(`Triaged ${filed + manual + autofix + unmatched} new fingerprints:`);
  console.log(`  auto_fix queued:    ${autofix}`);
  console.log(`  approval issues:    ${filed}`);
  console.log(`  manual issues:      ${manual}`);
  console.log(`  unmatched (review): ${unmatched}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
