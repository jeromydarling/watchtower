# Watchtower runbooks

One-page playbooks for every monitored project. When an alert email lands in
your inbox, the narrative includes a link straight to the relevant runbook so
you know what to check without digging.

## Files

- `_template.md` — the source template. New runbooks copy from this.
- `<slug>.md` — one per project. Slug matches `projects.json`.

## Regenerating

`scripts/gen-runbooks.ts` creates stubs for any project that doesn't have one
yet. It **never overwrites** existing runbooks, so your hand-edited quirks
and escalation notes stay put.

```
node --experimental-strip-types scripts/gen-runbooks.ts
```

(Or use plain Node on the CLI — see the commit that added this directory.)

## Convention

- Keep each runbook skimmable. If it's longer than a phone screen, you won't read it during an incident.
- Fill in the "Known quirks" section as you learn app-specific gotchas — that's the whole point.
- The "Where things live" section links out to the relevant Supabase project once we finish org consolidation (see [docs/consolidating-orgs.md](../docs/consolidating-orgs.md)).
