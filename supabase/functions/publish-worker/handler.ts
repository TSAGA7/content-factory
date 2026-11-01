// Called by pg_cron every minute. Processes due publishing jobs.
import { runTick } from "../_shared/engine.ts";
import { handler, json, requireWorker, serviceClient } from "../_shared/edge.ts";

export default handler(async (req) => {
  await requireWorker(req);
  const db = serviceClient();
  const workerId = `edge-${crypto.randomUUID().slice(0, 8)}`;
  const deadline = Date.now() + 100_000;
  const total = { claimed: 0, succeeded: 0, failed: 0, deferred: 0, manual: 0, errors: [] as string[] };
  while (Date.now() < deadline) {
    const r = await runTick(db, workerId, 5);
    total.claimed += r.claimed; total.succeeded += r.succeeded; total.failed += r.failed;
    total.deferred += r.deferred; total.manual += r.manual; total.errors.push(...r.errors);
    if (r.claimed < 5) break;
  }
  return json(req, { ok: true, workerId, ...total });
});
