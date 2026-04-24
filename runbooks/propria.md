# Propria runbook

Short, human-language instructions for when Watchtower flags Propria.
No jargon. No code walls. Glance, act, breathe.

---

## At a glance
- **Name / slug**: Propria / `propria`
- **Live URL**: https://propria.lovable.app
- **Repo**: https://github.com/jeromydarling/propria-1e798e8e
- **Tier**: Tier 2
- **Dashboard tile**: https://jeromydarling.github.io/watchtower/#propria

## If the site is down (red 🔴)

1. Open the URL yourself in a new tab. Does it actually fail? Sometimes it's a transient blip and the next check (5 min later) will clear.
2. If it really is down, open the repo's Actions tab — is a deploy failing?
3. Check the Supabase project for this app (see below) — any red in the edge-function logs?
4. If you can't figure it out fast, roll back to the last green deploy:
   - Open the repo on GitHub → Actions → pick the last successful deploy → re-run it.

## If the site is yellow 🟡

- The page returned but a subsystem (DB / auth / stripe / etc) is reporting not-ok.
- Look at the dashboard row for which subsystem failed. The alert email also lists them.
- Yellow usually clears on its own within one or two check cycles. If it stays yellow 15+ minutes, treat it like red.

## If TLS cert is close to expiry

- Watchtower alerts once under 14 days. Most `.lovable.app` URLs auto-renew — usually nothing to do.
- If this is a custom domain: renew via the DNS provider or Cloudflare.

## If DNS stops resolving

- Custom domain only. Open the registrar, confirm the A / CNAME records still point where they should.
- For Lovable-hosted apps, the `.lovable.app` URL should always work even if the custom domain breaks.

## Where things live

- **Lovable app URL**: https://propria.lovable.app
- **Supabase org / project**: TODO — fill in the Supabase project ref once we consolidate orgs (see [docs/consolidating-orgs.md](../docs/consolidating-orgs.md)).
- **Edge functions**: in the repo under `supabase/functions/*`.

## Known quirks

<!-- Add any app-specific gotchas here as you discover them. -->

- _No known quirks yet. Edit this file as you learn._

## Escalation

If the app has been down for 15+ minutes and you can't figure it out:
- Check the last deploy commit — did it break something obvious?
- Revert the last commit on `main` and re-deploy.
- If still stuck, flip the Lovable project to maintenance mode and message support.
