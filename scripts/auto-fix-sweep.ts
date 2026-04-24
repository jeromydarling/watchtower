/**
 * Watchtower auto-fix sweep.
 *
 * Clones each repo in projects.json and walks supabase/functions/ looking for:
 *   [auto-fix]
 *     - floating @supabase/supabase-js imports
 *     - deno.lock files
 *   [approval]
 *     - anything else from the original audit checklist we might want to track
 *
 * Auto-fixable findings get a PR (auto-merged).
 * Approval-needed findings become an issue tagged `watchtower:awaiting-approval`.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const { projects } = JSON.parse(readFileSync(resolve(ROOT, "projects.json"), "utf-8"));
const WORK = "/tmp/watchtower-sweep";
rmSync(WORK, { recursive: true, force: true });
execSync(`mkdir -p ${WORK}`);

const SUPABASE_PIN = "https://esm.sh/@supabase/supabase-js@2.57.2";
const RE_FLOATING = /["']https:\/\/esm\.sh\/@supabase\/supabase-js@(?:latest|\d+)["']/g;
const RE_NPM_SUPABASE = /["']npm:@supabase\/supabase-js(?:@[^"']*)?["']/g;
const BRANCH = "watchtower/auto-fix";

function sh(cmd: string, cwd?: string) {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" });
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".git") continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

async function sweepRepo(repo: string) {
  const dir = join(WORK, repo.replace("/", "__"));
  try {
    sh(`gh repo clone ${repo} ${dir} -- --quiet --depth=1`);
  } catch {
    console.log(`[${repo}] clone failed, skipping`);
    return;
  }

  const functionsDir = join(dir, "supabase/functions");
  if (!existsSync(functionsDir)) { console.log(`[${repo}] no supabase/functions/`); return; }

  let changed = 0;
  const changedFiles: string[] = [];

  // 1. Re-pin floating supabase-js
  for (const fp of walk(functionsDir)) {
    if (!/\.(ts|tsx|js|mjs)$/.test(fp)) continue;
    const text = readFileSync(fp, "utf-8");
    const next = text
      .replace(RE_FLOATING, `"${SUPABASE_PIN}"`)
      .replace(RE_NPM_SUPABASE, `"${SUPABASE_PIN}"`);
    if (next !== text) {
      writeFileSync(fp, next);
      changedFiles.push(fp.replace(dir + "/", ""));
      changed++;
    }
  }

  // 2. Delete any deno.lock in supabase/functions/
  const removedLocks: string[] = [];
  for (const fp of walk(functionsDir)) {
    if (fp.endsWith("/deno.lock")) {
      rmSync(fp);
      removedLocks.push(fp.replace(dir + "/", ""));
      changed++;
    }
  }

  if (changed === 0) {
    console.log(`[${repo}] clean`);
    return;
  }

  sh(`git checkout -B ${BRANCH}`, dir);
  sh(`git -c user.email=watchtower@users.noreply.github.com -c user.name=watchtower-bot add -A`, dir);
  sh(`git -c user.email=watchtower@users.noreply.github.com -c user.name=watchtower-bot commit -m "fix(watchtower): re-pin supabase-js and remove deno.lock"`, dir);
  sh(`git push -u origin ${BRANCH} --force-with-lease`, dir);

  const bodyLines = [
    "## Watchtower auto-fix",
    "",
    "Routine sweep detected drift from pinned edge-function imports. Applied:",
    "",
    changedFiles.length ? `- Re-pinned ${changedFiles.length} \`@supabase/supabase-js\` import(s) to \`${SUPABASE_PIN}\`.` : "",
    removedLocks.length ? `- Removed ${removedLocks.length} stray \`deno.lock\` file(s) from \`supabase/functions/\`.` : "",
    "",
    "This PR will be auto-merged because the fix is in Watchtower's pre-approved set.",
    "",
    "—Watchtower",
  ].filter(Boolean).join("\n");

  writeFileSync("/tmp/pr_body.md", bodyLines);
  try {
    const prJson = sh(
      `gh pr create --repo ${repo} --base main --head ${BRANCH} ` +
      `--title "fix(watchtower): re-pin supabase-js and remove deno.lock" ` +
      `--body-file /tmp/pr_body.md`
    );
    const url = prJson.trim().split("\n").pop() ?? "";
    console.log(`[${repo}] PR opened ${url}`);
    sh(`gh pr merge ${url} --squash --auto --delete-branch`);
  } catch (e: any) {
    console.log(`[${repo}] PR creation failed (maybe already exists):`, e?.message?.slice(0, 200));
  }
}

async function main() {
  for (const p of projects) {
    if (!p.repo) continue;
    try { await sweepRepo(p.repo); }
    catch (e: any) { console.error(`[${p.repo}]`, e?.message?.slice(0, 300)); }
  }
}

main();
