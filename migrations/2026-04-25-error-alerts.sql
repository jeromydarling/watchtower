-- Watchtower error-rate alerting (applied 2026-04-25)
--
-- Tracks which (slug, fingerprint) we've already emailed about so we don't
-- spam every 5 minutes when a bug keeps firing. Re-alert if >24h since last.

create table if not exists error_alerts_sent (
  slug             text not null,
  fingerprint      text not null,
  last_alerted_at  timestamptz not null default now(),
  last_count       integer not null default 0,
  primary key (slug, fingerprint)
);

create index if not exists idx_error_alerts_sent_slug on error_alerts_sent(slug);

-- RPC: rolling-window error counts grouped by fingerprint.
-- Used by run-checks.ts to find "≥5 errors/hour same fingerprint" alerts.
create or replace function errors_recent_by_fingerprint(window_minutes int default 60)
returns table(slug text, fingerprint text, message text, occurrences int, last_seen timestamptz)
language sql stable as $$
  select slug,
         fingerprint,
         max(message) as message,
         sum(count)::int as occurrences,
         max(last_seen_at) as last_seen
  from errors
  where last_seen_at > now() - make_interval(mins => window_minutes)
  group by slug, fingerprint
$$;
