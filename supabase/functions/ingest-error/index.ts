// Watchtower error ingestion edge function.
// Accepts POST { slug, message, stack, url, user_agent, user_id } from any browser app.
// De-dupes by SHA-256 of (slug + normalized stack) and upserts into public.errors.
//
// Deploy:  supabase functions deploy ingest-error --project-ref <watchtower-project-ref>
// Then:    set config.toml -> [functions.ingest-error] verify_jwt = false
//
// Client snippet: see clients/error-reporter.js

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
};

function normalize(stack: string | undefined, message: string): string {
  // Strip line/column numbers and anonymous urls to get a stable fingerprint.
  const src = (stack ?? message).toString();
  return src
    .replace(/:\d+:\d+/g, "")
    .replace(/https?:\/\/[^\s)]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405, headers: { ...CORS, "content-type": "application/json" },
    });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400, headers: { ...CORS, "content-type": "application/json" },
    });
  }

  const slug = String(body.slug ?? "unknown").slice(0, 80);
  const message = String(body.message ?? "").slice(0, 2000);
  const stack = body.stack ? String(body.stack).slice(0, 8000) : null;
  const url = body.url ? String(body.url).slice(0, 2000) : null;
  const ua = body.user_agent ? String(body.user_agent).slice(0, 500) : null;
  const uid = body.user_id ? String(body.user_id).slice(0, 100) : null;

  if (!message) {
    return new Response(JSON.stringify({ error: "message required" }), {
      status: 400, headers: { ...CORS, "content-type": "application/json" },
    });
  }

  const fingerprint = await sha256(slug + "|" + normalize(stack ?? undefined, message));

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  // Upsert: if fingerprint exists, bump count + last_seen_at
  const { data: existing } = await sb
    .from("errors")
    .select("id,count")
    .eq("slug", slug)
    .eq("fingerprint", fingerprint)
    .maybeSingle();

  if (existing) {
    await sb.from("errors").update({
      count: existing.count + 1,
      last_seen_at: new Date().toISOString(),
    }).eq("id", existing.id);
  } else {
    await sb.from("errors").insert({
      slug, fingerprint, message, stack, url, user_agent: ua, user_id: uid,
    });
  }

  return new Response(JSON.stringify({ ok: true, fingerprint }), {
    status: 200, headers: { ...CORS, "content-type": "application/json" },
  });
});
