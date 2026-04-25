-- Watchtower fix lifecycle (applied 2026-04-25)
--
-- Three new tables turn Watchtower from a status board into a fix-lifecycle
-- dashboard with four lanes: auto-fixed, needs approval, manual, activity log.

-- ─────────────────────────────────────────────────────────────────────────
-- triage_rules: the pattern library. Each row says "if an error matches
-- this regex, route it into <lane> and (optionally) attach a fix recipe."
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists triage_rules (
  id              bigserial primary key,
  pattern         text not null,            -- regex matched against error.message
  lane            text not null check (lane in ('auto_fix','needs_approval','manual')),
  fix_recipe      text,                     -- key into the auto-fixer's switch (e.g. 'pin_supabase_js')
  reason          text not null,            -- human explanation: "Lovable owns this DB, you can't PR it"
  enabled         boolean not null default true,
  created_at      timestamptz not null default now()
);

-- Seed with starter rules. These match what auto-fix-sweep.ts already handles
-- plus the manual-lane patterns the user called out (DB / auth / payment).
insert into triage_rules (pattern, lane, fix_recipe, reason) values
  ('deno\.lock',                       'auto_fix',       'delete_deno_lock',  'Stale deno.lock blocks deploys; safe to delete + redeploy.'),
  ('std@0\.1[0-8][0-9]',               'auto_fix',       'bump_std',          'Deprecated std import; bump to 0.190.0 across the function.'),
  ('@supabase/supabase-js[^@]*@[12]\.', 'auto_fix',       'pin_supabase_js',   'Out-of-date supabase-js pin; bump to current.'),
  ('CORS|cross.origin',                'needs_approval', 'add_cors_headers',  'Missing CORS headers; needs approval before shipping.'),
  ('verify_jwt',                       'needs_approval', 'set_verify_jwt',    'Webhook missing verify_jwt=false; needs approval.'),
  -- Manual lane: things only Lovable / DB owners can fix.
  ('row.level.security|RLS|policy violation', 'manual',  null,                'Row-level security policy issue. The Supabase project lives in a Lovable-owned org, so this needs a manual fix in the Supabase dashboard.'),
  ('relation .* does not exist',       'manual',         null,                'Missing table or column. DB schema changes need a manual migration in the Supabase dashboard.'),
  ('column .* does not exist',         'manual',         null,                'Missing column. Same as above \u2014 manual migration needed.'),
  ('auth.invalid|invalid_grant|JWT expired', 'manual',   null,                'Supabase auth misconfiguration. Check the auth keys and JWT settings in the Supabase dashboard.'),
  ('Stripe|payment_intent|card_declined', 'manual',      null,                'Payment provider error. Check Stripe dashboard and webhook delivery.')
on conflict do nothing;

-- ─────────────────────────────────────────────────────────────────────────
-- triage_decisions: one row per (slug, fingerprint) we've classified.
-- Tracks which lane it landed in, whether it's been resolved, and the
-- GitHub artifact (PR or issue) we created.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists triage_decisions (
  slug              text not null,
  fingerprint       text not null,
  lane              text not null check (lane in ('auto_fix','needs_approval','manual','unmatched')),
  fix_recipe        text,
  rule_id           bigint references triage_rules(id),
  pr_url            text,                   -- if we opened a draft PR (needs_approval lane)
  issue_url         text,                   -- if we filed an issue (manual lane)
  status            text not null default 'open' check (status in ('open','approved','fixed','dismissed')),
  triaged_at        timestamptz not null default now(),
  resolved_at       timestamptz,
  primary key (slug, fingerprint)
);

create index if not exists idx_triage_decisions_lane_status on triage_decisions(lane, status);

-- ─────────────────────────────────────────────────────────────────────────
-- activity_log: append-only journal of "stuff Watchtower did."
-- Auto-fixes, approvals, manual-lane filings, dismissals \u2014 all in one
-- chronological feed, with GitHub URLs for receipts.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists activity_log (
  id            bigserial primary key,
  occurred_at   timestamptz not null default now(),
  actor         text not null,                  -- 'watchtower-bot' | 'user' | 'lovable'
  action        text not null,                  -- 'auto_fixed' | 'opened_pr' | 'merged_pr' | 'filed_issue' | 'dismissed' | 'manual_resolved'
  slug          text,
  fingerprint   text,
  summary       text not null,                  -- one-line human description
  github_url    text                            -- PR / commit / issue link
);

create index if not exists idx_activity_log_occurred_at on activity_log(occurred_at desc);
create index if not exists idx_activity_log_slug_time on activity_log(slug, occurred_at desc);
