# 🗼 Watchtower

**A single-pane monitor, alerter, and auto-repair tool for all my Lovable/Supabase projects.**

Dashboard: `https://jeromydarling.github.io/watchtower/`
(private repo → only you can see it once you're signed into GitHub)

## How it works, in one picture

```
 projects.json ──► GitHub Actions (every 5 min) ──► hits /health on each project
                                │
                                ├──► Supabase table `checks`
                                ├──► public/status.json  (mobile dashboard)
                                └──► alerts/outbox/*.json
                                          │
                        Computer cron (Gmail connector, 5 min)
                                          │
                                          ▼
                                   you get an email
```

```
 frontend errors ──► `window.onerror` ──► Watchtower ingest-error edge function
                                            ├──► de-duped by stack-trace fingerprint
                                            └──► weekly digest email
```

## Add a new project — one line

Open `projects.json` and add a row:

```json
{ "name": "New App", "slug": "new-app", "repo": "jeromydarling/new-app",
  "health_url": "https://<supabase-ref>.functions.supabase.co/health",
  "critical": false }
```

Commit, push, done. The next 5-minute run picks it up.

## Per-project setup (one-time per app)

1. Copy `clients/health-endpoint-template.ts` → `supabase/functions/health/index.ts`.
2. In `supabase/config.toml`, mark it public:
   ```toml
   [functions.health]
   verify_jwt = false
   ```
3. `supabase functions deploy health`
4. Paste the deployed URL into `projects.json`.
5. *(Optional)* Drop `clients/error-reporter.js` into your frontend entrypoint:
   ```js
   import { initWatchtower } from "./watchtower-error-reporter.js";
   initWatchtower({ slug: "new-app" });
   ```

## Alert rules

| Event | Action |
|---|---|
| Critical project flips ok → down | **Immediate email** |
| Non-critical project flips ok → down | **Immediate email** (still, you'll want to know) |
| Any project recovers | **Recovery email** ("<name> is back up") |
| Frontend error reports | **Weekly digest email** on Mondays |

Emails are composed by a Computer scheduled task that reads `alerts/outbox/` and
sends via your Gmail connector — so they sound human and can summarize the 24h
context instead of just "it's down."

## Auto-fix (pre-approved, fires nightly at 2:17a CT)

These patterns are fixed without asking because they're always safe:

- Floating `@supabase/supabase-js@2` imports → re-pin to `2.57.2`
- `deno.lock` files inside `supabase/functions/` → deleted

Everything else that the sweep finds becomes an **approval issue** in the
relevant repo. React with 👍 and Watchtower applies it; 👎 and it closes.

## Dashboard features

- Mobile-first, dark/light auto, single HTML file
- Sorted: problems first, critical projects first, alphabetical within
- Per-project subsystem checks (database, auth, stripe, …) expandable
- 24h / 7d uptime %, incidents-this-week count
- Auto-refreshes every 60s while open

## Secrets to set

In the watchtower repo settings → Secrets and variables → Actions:

| Secret | Used by | What it is |
|---|---|---|
| `WATCHTOWER_SUPABASE_URL` | check.yml | URL of the Watchtower Supabase project (not your app Supabase) |
| `WATCHTOWER_SUPABASE_SERVICE_ROLE_KEY` | check.yml | Service role key for the Watchtower Supabase project |
| `WATCHTOWER_MONITORED_REPOS_TOKEN` | auto-fix.yml, approve-fix.yml | Fine-grained PAT with `contents: write`, `pull_requests: write`, `issues: write` on your monitored repos |

## Files

```
projects.json                       # single source of truth
scripts/run-checks.ts               # 5-min check loop
scripts/auto-fix-sweep.ts           # nightly sweep across monitored repos
scripts/apply-approved.ts           # applies 👍-approved fixes
supabase/schema.sql                 # apply once in Supabase SQL editor
supabase/functions/ingest-error/    # error reporter endpoint
clients/health-endpoint-template.ts # drop into each monitored project
clients/error-reporter.js           # drop into each monitored frontend
public/index.html                   # the dashboard
public/status.json                  # regenerated each run
.github/workflows/check.yml         # cron + deploy-pages
.github/workflows/auto-fix.yml      # nightly sweep
.github/workflows/approve-fix.yml   # approval poller
```

## Design principles

- **Single source of truth** — everything is in `projects.json` + the Supabase tables.
- **Independent failure domain** — if your app Supabase dies, Watchtower still runs.
- **Zero coupling** — each monitored project only needs a `/health` endpoint.
- **Free forever** — GitHub Pages + GitHub Actions cron + one free Supabase project.
- **Portable** — the check loop is 250 lines of TypeScript with one dependency.
