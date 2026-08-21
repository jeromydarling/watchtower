/**
 * sync-rota — regenerate the federation half of projects.json from the CROS rota.
 *
 * WHY: `src/content/federationRota.ts` in thecros is the single source of truth
 * for what the federation contains and where each application actually serves.
 * Watchtower kept its own hand-typed list, and the two drifted: four projects
 * were being pinged at addresses the rota had long since moved off, which is
 * the failure mode where a monitor is quietly watching nothing.
 *
 * So the list is derived rather than maintained. Adding an application to the
 * rota and re-running this is the whole job.
 *
 * USAGE
 *   npx tsx scripts/sync-rota.ts --rota ../thecros/src/content/federationRota.ts
 *   npx tsx scripts/sync-rota.ts --rota <path> --check   # exit 1 if out of date
 *
 * The rota lives in a private repository, so this takes a path to a local
 * checkout rather than fetching. A CI job would need a token; a person with
 * both repositories checked out needs nothing.
 *
 * WHAT IT PRESERVES
 *   - Projects whose slug is not in the rota (the hub itself, and anything
 *     outside the federation) are kept exactly as they are.
 *   - The `critical` flag on an existing project is kept. The rota has no
 *     opinion about what wakes somebody up at night; that is Watchtower's.
 *
 * WHAT IT SKIPS
 *   Applications with no live URL. `run-checks` records "No health_url
 *   configured" as an error, so including an undeployed application would
 *   manufacture a permanent failure. Skipped ones are printed on every run so
 *   the omission stays visible rather than becoming silent.
 */

import { readFileSync, writeFileSync } from "node:fs";

interface Project {
  name: string;
  slug: string;
  repo: string;
  health_url: string;
  critical: boolean;
}

/**
 * Rota id → GitHub repository, where they differ.
 *
 * Most Lovable-created repositories carry a random suffix, and a few
 * applications were renamed after their repository was made. Anything absent
 * here is assumed to match its rota id.
 */
const REPO_BY_ID: Record<string, string> = {
  communis: "communis-b47839b1",
  propria: "propria-aac78f12",
  transitus: "transitus-be0eceba",
  hortus: "hortus-claude-s-garden",
  bitoku: "bitoku-949e0ed7",
  refugium: "refugium-a261235f",
  resurrectio: "resurrectio-3d07f98c",
  vigilia: "vigilia-ffa3c410",
  nave: "thegreatnave-49ebb963",
  viapublica: "via-publica",
  fabrica: "fabrica-forge",
  verto: "rezene",
  flavor: "flavordoctors",
  heritage: "heritage-catholic",
  collegium: "collegium-connect",
  tutela: "viatutela",
  transit: "transit-os",
  vrt: "vrtmethod",
  commissio: "commissio",
};

/**
 * Slugs Watchtower used before the rota became the source of truth.
 *
 * Three projects were filed here under their repository name while the rota
 * calls them something shorter. Without this the sync treats each as two
 * different projects: it adds the rota's and keeps the old one, and the
 * dashboard grows a duplicate that is pinged at a stale address forever.
 */
const SLUG_ALIASES: Record<string, string> = {
  "via-publica": "viapublica",
  "fabrica-forge": "fabrica",
  vrtmethod: "vrt",
};

interface RotaApp {
  id: string;
  name: string;
  url: string | null;
}

/**
 * Pull ROTA_APPS out of the TypeScript source.
 *
 * Reading it with a regex rather than importing it: the rota file imports
 * nothing and the entries are written on a fixed two-line shape, so a parser
 * here would be more machinery than the job needs. The count assertion below
 * is what catches the day that stops being true.
 */
function parseRota(source: string): RotaApp[] {
  const start = source.indexOf("ROTA_APPS");
  const end = source.indexOf("ROTA_EDGES");
  if (start < 0 || end < 0) throw new Error("Could not find ROTA_APPS in the rota file");

  const body = source.slice(start, end);
  const re = /\{ id: '([^']+)', name: '([^']+)', domain: '[^']+', url: (null|'[^']+')/g;
  const apps: RotaApp[] = [];
  for (const m of body.matchAll(re)) {
    apps.push({ id: m[1], name: m[2], url: m[3] === "null" ? null : m[3].slice(1, -1) });
  }
  if (apps.length === 0) throw new Error("Parsed zero applications — the rota's shape has changed");
  return apps;
}

function main(): void {
  const args = process.argv.slice(2);
  const rotaPath = args[args.indexOf("--rota") + 1];
  const checkOnly = args.includes("--check");

  if (!rotaPath || rotaPath.startsWith("--")) {
    console.error("usage: sync-rota.ts --rota <path to federationRota.ts> [--check]");
    process.exit(2);
  }

  const apps = parseRota(readFileSync(rotaPath, "utf8"));
  const config = JSON.parse(readFileSync("projects.json", "utf8")) as {
    $schema?: string;
    projects: Project[];
  };

  const canonical = (slug: string) => SLUG_ALIASES[slug] ?? slug;
  const existing = new Map(config.projects.map((p) => [canonical(p.slug), p]));
  const rotaIds = new Set(apps.map((a) => a.id));

  const deployed = apps.filter((a) => a.url !== null);
  const skipped = apps.filter((a) => a.url === null);

  const fromRota: Project[] = deployed.map((a) => ({
    name: a.name,
    slug: a.id,
    repo: `jeromydarling/${REPO_BY_ID[a.id] ?? a.id}`,
    health_url: a.url as string,
    // A project Watchtower already knows about keeps whatever urgency it was
    // given. A new one starts non-critical: everything is critical to nobody.
    critical: existing.get(a.id)?.critical ?? false,
  }));

  // Anything Watchtower watches that the rota does not describe — the hub
  // itself, and the projects outside the federation — is left untouched.
  const kept = config.projects.filter((p) => !rotaIds.has(canonical(p.slug)));

  const merged = { ...config, projects: [...fromRota, ...kept] };
  const next = JSON.stringify(merged, null, 2) + "\n";
  const current = readFileSync("projects.json", "utf8");

  if (checkOnly) {
    if (next !== current) {
      console.error("projects.json is out of date with the rota. Run without --check.");
      process.exit(1);
    }
    console.log("projects.json matches the rota.");
    return;
  }

  writeFileSync("projects.json", next);

  const added = fromRota.filter((p) => !existing.has(p.slug)).map((p) => p.slug);
  const moved = fromRota
    .filter((p) => existing.has(p.slug) && existing.get(p.slug)!.health_url !== p.health_url)
    .map((p) => `${p.slug}: ${existing.get(p.slug)!.health_url} → ${p.health_url}`);

  console.log(`${merged.projects.length} projects (${fromRota.length} from the rota, ${kept.length} kept).`);
  if (added.length) console.log(`\nAdded (${added.length}): ${added.join(", ")}`);
  if (moved.length) console.log(`\nAddress corrected (${moved.length}):\n  ${moved.join("\n  ")}`);
  if (skipped.length) {
    console.log(`\nSkipped, no live URL in the rota (${skipped.length}): ${skipped.map((a) => a.id).join(", ")}`);
  }
}

main();
