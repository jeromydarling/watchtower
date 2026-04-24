/**
 * Generate per-project runbook stubs from runbooks/_template.md.
 *
 * Safe to re-run: only creates files that don't already exist, so your
 * hand-edited quirks + escalation notes stay put.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const projects = JSON.parse(
  readFileSync(resolve(ROOT, "projects.json"), "utf8")
).projects;

const template = readFileSync(
  resolve(ROOT, "runbooks/_template.md"),
  "utf8"
);

let created = 0;
let skipped = 0;

for (const p of projects) {
  const outPath = resolve(ROOT, "runbooks", `${p.slug}.md`);
  if (existsSync(outPath)) {
    skipped++;
    continue;
  }
  const body = template
    .replace(/\{PROJECT_NAME\}/g, p.name)
    .replace(/\{SLUG\}/g, p.slug)
    .replace(/\{HEALTH_URL\}/g, p.health_url || "(not set yet)")
    .replace(/\{REPO\}/g, p.repo)
    .replace(/\{TIER\}/g, p.critical ? "Tier 1 (critical)" : "Tier 2");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, body);
  created++;
  console.log(`created runbooks/${p.slug}.md`);
}

console.log(`\nDone. created=${created} skipped=${skipped}`);
