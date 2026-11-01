// Hourly: re-check platform connections, mark missing media, housekeeping.
import { checkTelegram } from "../_shared/adapters.ts";
import { loadCredentials } from "../_shared/crypto.ts";
import { audit, handler, json, notify, requireWorker, serviceClient } from "../_shared/edge.ts";

export default handler(async (req) => {
  await requireWorker(req);
  const db = serviceClient();
  const report = { checked: 0, changed: 0, mediaMissing: 0 };

  // 1. Telegram connections (bot still admin, token still valid)
  const { data: accounts } = await db.from("social_accounts").select("*").eq("platform", "telegram")
    .in("connection_status", ["connected", "expired", "insufficient_permissions", "error"]);
  for (const a of accounts ?? []) {
    const creds = await loadCredentials<{ bot_token: string }>(a.id).catch(() => null);
    if (!creds) continue;
    const c = await checkTelegram(creds.bot_token, a.external_id ?? a.handle);
    report.checked++;
    const now = new Date().toISOString();
    if (c.status !== a.connection_status) {
      report.changed++;
      await db.from("social_accounts").update({ connection_status: c.status, last_checked_at: now, last_error: c.ok ? null : c.message, last_error_at: c.ok ? null : now }).eq("id", a.id);
      await audit(db, a.owner_id, c.ok ? "info" : "warn", "connection_changed", { type: "social_account", id: a.id }, `«${a.name}»: ${c.message}`);
      if (!c.ok) await notify(db, a.owner_id, "warn", `Проблема с подключением «${a.name}»`, c.message, "/accounts");
      if (c.ok) {
        // resume jobs that were blocked by credentials
        const { data: jobs } = await db.from("publishing_jobs").select("id, post_id").eq("account_id", a.id).eq("status", "blocked").in("last_error_category", ["auth", "permission"]);
        for (const j of jobs ?? []) {
          await db.from("publishing_jobs").update({ status: "queued", run_at: now, last_error: null }).eq("id", j.id);
          await db.from("content_posts").update({ status: "scheduled", last_error: null }).eq("id", j.post_id);
        }
      }
    } else {
      await db.from("social_accounts").update({ last_checked_at: now }).eq("id", a.id);
    }
  }

  // 2. Media scheduled within 24h must exist
  const soon = new Date(Date.now() + 24 * 3600_000).toISOString();
  const { data: posts } = await db.from("content_posts").select("id, owner_id, post_media(media_assets(id, storage_path, file_name, status))")
    .eq("status", "scheduled").lte("scheduled_at", soon);
  for (const p of (posts ?? []) as unknown as { id: string; owner_id: string; post_media: { media_assets: { id: string; storage_path: string; file_name: string; status: string } }[] }[]) {
    for (const pm of p.post_media) {
      const m = pm.media_assets;
      const dir = m.storage_path.split("/").slice(0, -1).join("/");
      const name = m.storage_path.split("/").pop()!;
      const { data: found } = await db.storage.from("media").list(dir, { search: name, limit: 1 });
      if (!found?.length && m.status !== "missing") {
        report.mediaMissing++;
        await db.from("media_assets").update({ status: "missing" }).eq("id", m.id);
        await notify(db, p.owner_id, "error", "Файл для публикации пропал", `«${m.file_name}» не найден в хранилище`, `/posts/${p.id}`);
      }
    }
  }

  await db.from("worker_heartbeats").upsert({ worker: "maintenance", last_tick_at: new Date().toISOString(), last_result: report });
  return json(req, { ok: true, ...report });
});
