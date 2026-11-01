// Single-deployment router: /functions/v1/cf/<name>. Each handler does its own auth
// (user JWT via requireUser, or x-worker-secret via requireWorker), so verify_jwt is off.
// The same handlers are also deployable as separate functions (supabase functions deploy <name>).
import publishWorker from "../publish-worker/handler.ts";
import maintenance from "../maintenance/handler.ts";
import postsSchedule from "../posts-schedule/handler.ts";
import aiGenerate from "../ai-generate/handler.ts";
import accountsConnect from "../accounts-connect/handler.ts";
import appSettings from "../app-settings/handler.ts";
import { corsHeaders } from "../_shared/edge.ts";

const routes: Record<string, (req: Request) => Promise<Response>> = {
  "publish-worker": publishWorker,
  "maintenance": maintenance,
  "posts-schedule": postsSchedule,
  "ai-generate": aiGenerate,
  "accounts-connect": accountsConnect,
  "app-settings": appSettings,
};

Deno.serve((req) => {
  const name = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  const h = routes[name];
  if (!h) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { ...corsHeaders(req), "Content-Type": "application/json" } });
  return h(req);
});
