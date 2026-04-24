/**
 * Standard Watchtower /health edge function.
 * Drop this into supabase/functions/health/index.ts in any monitored project.
 *
 * Returns a small JSON document describing whether the project can reach its
 * core dependencies. Watchtower hits this URL every 5 minutes.
 *
 * Deploy:
 *   supabase functions deploy health
 *
 * In supabase/config.toml:
 *   [functions.health]
 *   verify_jwt = false
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

type Checks = Record<string, "ok" | "degraded" | "down">;

async function checkDatabase(): Promise<"ok" | "down"> {
  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );
    // A trivial query that doesn't depend on any user table
    const { error } = await sb.rpc("version" as any).abortSignal(AbortSignal.timeout(3000));
    // If the rpc doesn't exist that's fine — any response (including 404 from PostgREST) proves connectivity
    return error && error.code === "PGRST202" ? "ok" : (error ? "down" : "ok");
  } catch { return "down"; }
}

async function checkAuth(): Promise<"ok" | "down"> {
  try {
    // getSession against the auth endpoint is a cheap connectivity probe
    const url = Deno.env.get("SUPABASE_URL")! + "/auth/v1/settings";
    const res = await fetch(url, {
      headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok ? "ok" : "down";
  } catch { return "down"; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const checks: Checks = {};

  const [db, auth] = await Promise.all([checkDatabase(), checkAuth()]);
  checks.database = db;
  checks.auth = auth;

  // Add project-specific checks here, e.g.:
  //   checks.stripe = await checkStripe();
  //   checks.weatherapi = await checkWeatherApi();

  const overall: "ok" | "degraded" | "down" =
    Object.values(checks).every((v) => v === "ok") ? "ok" :
    Object.values(checks).some((v) => v === "down") ? "down" : "degraded";

  return new Response(JSON.stringify({
    status: overall,
    checks,
    version: Deno.env.get("GIT_SHA") ?? "unknown",
    timestamp: new Date().toISOString(),
  }), {
    status: overall === "down" ? 503 : 200,
    headers: { ...CORS, "content-type": "application/json" },
  });
});
