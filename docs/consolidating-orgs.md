# Consolidating Supabase orgs

## The problem, in one paragraph

Right now 15 of the 17 monitored apps live in Supabase orgs that are owned by
Lovable's builder accounts, not by the CROS LLC org. Our personal access token
only has management-API permissions on the one project we own directly
(Watchtower itself, `mgtbbveeqnpbesfmtkng`). Everything else we monitor via
public URL ping only — we can see whether the app is up, but we can't read edge
function logs, run SQL against their databases, or deploy fixes through CI.

This is fine for basic uptime, but it caps what Watchtower can do. In
particular: no deep health checks, no edge-function log tails, no automated
`/health` deploy, and no cross-project quota rollups.

## The options

### Option A: Transfer every project to CROS LLC org (the right answer eventually)

**What it buys us**: One PAT covers everything. `/health` deploys become
automatable. Edge function logs readable. Quota rollups make sense.

**How to do it**:

1. In the Lovable dashboard for each project, request transfer to the CROS LLC
   Supabase org (org id `nyvkuamwuxijciawsnip`).
2. Accept the transfer on the CROS side.
3. Rotate any environment variables / keys that the project embeds
   (service_role, JWT secrets) — transfers don't rotate keys, but it's a good
   moment for hygiene.
4. Re-run each app's CI to confirm connections still work.

**Cost**: zero in dollars — Supabase doesn't charge for transfers. The project
gets counted against CROS LLC's org quota. Free tier applies per project, so
this doesn't change free-tier math. Pro-tier projects continue billing on
whichever payment source they were on.

**Risks**: small — every project has a brief window where its keys rotate if
you choose to regenerate. Do it on a weekend. One project at a time.

**Effort**: ~15 min per project × 15 = half a day.

### Option B: Keep orgs separate, mint one PAT per org

**What it buys us**: Same deep access, no ownership shuffling.

**Reality check**: Supabase PATs are per-user, not per-org. Each Lovable
builder account would need to (a) invite you as a member, (b) you then mint a
PAT from *your* account that inherits the org membership. 15 invite-accept
cycles ≈ Option A effort but with weirder long-term ownership.

**Cost**: same as Option A.

**Risks**: if Lovable churns an account (cancels subscription, etc), you lose
access. Option A survives that.

### Option C: Stay on URL-ping monitoring (status quo)

**What it buys us**: Zero migration work, and honestly this is what we have
today. Watchtower still detects when an app is 500-ing, down, or TLS-expired.

**What we lose**: can't deploy `/health`, can't read edge function logs in
alerts, can't do anything fancier than "is the page returning 2xx."

**Cost**: zero. **Risks**: zero. **Effort**: zero.

## Recommendation

**Start with C, move to A as the apps mature.** URL-ping monitoring catches
99% of real incidents (the app is down / unreachable / 500-ing). The deep
access is only worth the migration cost once an app has real users and real
SLAs.

Concrete threshold: when an app gets ≥1,000 monthly actives or ≥$100 MRR,
transfer its Supabase project to CROS LLC (Option A). Until then, URL-ping
is enough.

## What to do right now

Nothing urgent. File this doc so the decision is captured. Revisit the first
time we want Watchtower to do something it can't do today (read logs, deploy
`/health`, etc).

## Project ownership reference

| Slug | Tier | Supabase org owner | Watchtower access |
|------|------|---------------------|-------------------|
| theschola | 1 | Lovable builder | URL-ping only |
| thecros | 1 | Lovable builder | URL-ping only |
| hortus | 1 | Lovable builder | URL-ping only |
| refugium | 2 | Lovable builder | URL-ping only |
| resurrectio | 2 | Lovable builder | URL-ping only |
| transitus | 2 | Lovable builder | URL-ping only |
| vigilia | 2 | Lovable builder | URL-ping only |
| communis | 2 | Lovable builder | URL-ping only |
| propria | 2 | Lovable builder | URL-ping only |
| cormundum | 2 | Lovable builder | URL-ping only |
| bitoku | 2 | Lovable builder | URL-ping only |
| rehearso | 2 | Lovable builder | URL-ping only |
| heritage-kitchen | 2 | Lovable builder | URL-ping only |
| via-publica | 2 | Lovable builder | URL-ping only |
| fabrica-forge | 2 | Lovable builder | URL-ping only |
| vrtmethod | 2 | Lovable builder | URL-ping only |
| **watchtower** | — | **CROS LLC** | **full (mgtbbveeqnpbesfmtkng)** |

catholic-insurance is deferred (no URL yet).

## Open questions

- Does Lovable support transferring the *entire* builder account into a
  user-owned Supabase org in one step, or does every project go individually?
  _(TODO: ask in Lovable discord / docs.)_
- If we move a project out of its Lovable-owned org, does Lovable still deploy
  updates correctly?
  _(TODO: test with one low-stakes project first — e.g. cormundum or bitoku.)_
