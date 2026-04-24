/**
 * Polls monitored repos for approval issues (label `watchtower:awaiting-approval`)
 * that have ≥1 👍 reaction, applies the stored fix described in the issue body,
 * and opens a PR. Closes the issue when merged.
 *
 * The issue body must contain a fenced ```json ... ``` block with shape:
 *   { "pattern": "1d_deprecated_std", "file": "...", "from": "...", "to": "..." }
 *
 * Writers of approval issues (auto-fix-sweep.ts in future expansions) should
 * embed that block so the replay here is mechanical and auditable.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { projects } = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../projects.json"), "utf-8")
);

function sh(cmd: string, cwd?: string) {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" });
}

type FixSpec = { pattern: string; file: string; from: string; to: string };

function extractSpec(body: string): FixSpec | null {
  const m = body.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try { return JSON.parse(m[1]) as FixSpec; } catch { return null; }
}

for (const p of projects) {
  if (!p.repo) continue;
  let issues: any[] = [];
  try {
    issues = JSON.parse(sh(
      `gh issue list --repo ${p.repo} --label "watchtower:awaiting-approval" --state open ` +
      `--json number,title,body,reactions`
    ));
  } catch { continue; }

  for (const iss of issues) {
    const up = iss.reactions?.["+1"] ?? 0;
    if (up < 1) continue;
    const spec = extractSpec(iss.body ?? "");
    if (!spec) { console.log(`[${p.repo}#${iss.number}] no spec block, skipping`); continue; }

    const dir = `/tmp/wt-approve-${p.repo.replace("/", "__")}-${iss.number}`;
    try {
      sh(`rm -rf ${dir} && gh repo clone ${p.repo} ${dir} -- --quiet --depth=1`);
      const fp = `${dir}/${spec.file}`;
      const text = readFileSync(fp, "utf-8");
      const next = text.split(spec.from).join(spec.to);
      if (next === text) { console.log(`[${p.repo}#${iss.number}] no replacement made`); continue; }
      sh(`echo ${JSON.stringify(next)} > ${fp}`);
      const branch = `watchtower/approved-${iss.number}`;
      sh(`git checkout -B ${branch}`, dir);
      sh(`git -c user.email=watchtower@users.noreply.github.com -c user.name=watchtower-bot commit -am "fix(watchtower): apply approved fix for #${iss.number}"`, dir);
      sh(`git push -u origin ${branch} --force-with-lease`, dir);
      const pr = sh(
        `gh pr create --repo ${p.repo} --base main --head ${branch} ` +
        `--title "fix(watchtower): apply approved fix for #${iss.number}" ` +
        `--body "Closes #${iss.number}. Approved via 👍 reaction."`
      ).trim().split("\n").pop();
      sh(`gh pr merge ${pr} --squash --auto --delete-branch`);
      sh(`gh issue close ${iss.number} --repo ${p.repo} --comment "Applied in ${pr}"`);
      console.log(`[${p.repo}#${iss.number}] applied → ${pr}`);
    } catch (e: any) {
      console.log(`[${p.repo}#${iss.number}] failed:`, e?.message?.slice(0, 200));
    }
  }
}
