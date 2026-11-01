// Schedule / reschedule a post: server-side validation, rule & conflict checks, atomic RPC.
import { z } from "zod";
import { isAllowedTime, localDateKey, nextAllowedTime, parseRules, validatePostForPlatform, type MediaInfo } from "../_shared/domain.ts";
import { handler, HttpError, json, readJson, requireUser, serviceClient } from "../_shared/edge.ts";

const Body = z.object({
  post_id: z.string().uuid(),
  mode: z.enum(["at", "next_slot", "now"]),
  at: z.string().datetime({ offset: true }).optional(),
  expected_version: z.number().int().optional(),
  force: z.boolean().optional(),
});

export default handler(async (req) => {
  const { userId, userClient } = await requireUser(req);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, "Некорректные параметры", "bad_request");
  const b = parsed.data;

  const { data: post } = await userClient.from("content_posts").select("*").eq("id", b.post_id).maybeSingle();
  if (!post) throw new HttpError(404, "Материал не найден", "not_found");
  if (!post.account_id) throw new HttpError(422, "Выберите аккаунт", "validation");
  if (!post.approved_by && post.status !== "approved") throw new HttpError(422, "Сначала утвердите материал", "not_approved");
  if (["publishing"].includes(post.status)) throw new HttpError(409, "Материал уже публикуется", "in_progress");
  const { data: account } = await userClient.from("social_accounts").select("*").eq("id", post.account_id).single();
  const { data: pm } = await userClient.from("post_media").select("role, media_assets(*)").eq("post_id", post.id).order("position");
  const media = ((pm ?? []) as unknown as { role: string; media_assets: MediaInfo }[]).filter((r) => r.role === "main").map((r) => r.media_assets);

  const issues = validatePostForPlatform(account.platform, post, media).filter((i) => i.severity === "error");
  if (account.connection_status === "mock") {
    // mock accounts may test any implemented format
    const idx = issues.findIndex((i) => i.field === "account");
    if (idx >= 0) issues.splice(idx, 1);
  }
  if (issues.length) return json(req, { error: "Материал не проходит проверку площадки", code: "validation", issues }, 422);

  const { data: ruleRow } = await userClient.from("automation_rules").select("rules").eq("account_id", account.id).maybeSingle();
  const rules = parseRules(ruleRow?.rules ?? { mode: "approval" });
  const tz = account.timezone || "Europe/Moscow";

  // other scheduled posts of the account (for interval & daily limit)
  const { data: others } = await userClient.from("content_posts").select("id, title, scheduled_at")
    .eq("account_id", account.id).in("status", ["scheduled", "platform_scheduled", "publishing"]).neq("id", post.id)
    .gte("scheduled_at", new Date(Date.now() - 7 * 86400_000).toISOString());
  const taken = (others ?? []).map((o) => ({ ...o, t: new Date(o.scheduled_at as string) }));

  const gapMs = rules.minIntervalMinutes * 60_000;
  const conflictsAt = (t: Date) => taken.filter((o) => Math.abs(o.t.getTime() - t.getTime()) < Math.max(gapMs, 60_000));
  const dayCount = (t: Date) => taken.filter((o) => localDateKey(o.t, tz) === localDateKey(t, tz)).length;

  let runAt: Date;
  const warnings: string[] = [];
  if (b.mode === "now") runAt = new Date();
  else if (b.mode === "at") {
    if (!b.at) throw new HttpError(400, "Укажите время", "bad_request");
    runAt = new Date(b.at);
    if (runAt.getTime() < Date.now() - 60_000) throw new HttpError(422, "Время в прошлом", "validation");
  } else {
    let cand: Date | null = new Date(Date.now() + 5 * 60_000);
    for (let i = 0; i < 2000 && cand; i++) {
      cand = nextAllowedTime(rules, cand, tz);
      if (!cand) break;
      if (conflictsAt(cand).length === 0 && (rules.maxPerDay === 0 || dayCount(cand) < rules.maxPerDay)) break;
      cand = new Date(cand.getTime() + 15 * 60_000);
    }
    if (!cand) throw new HttpError(422, "Нет свободного слота в ближайшие 30 дней по правилам аккаунта", "no_slot");
    runAt = cand;
  }

  const conflicts = conflictsAt(runAt);
  if (!isAllowedTime(rules, runAt, tz)) warnings.push("Время вне окон автопилота — публикация будет перенесена на ближайшее разрешённое");
  if (rules.maxPerDay > 0 && dayCount(runAt) >= rules.maxPerDay) warnings.push(`В этот день уже ${dayCount(runAt)} публикаций (лимит ${rules.maxPerDay})`);
  if (conflicts.length && !b.force) {
    return json(req, { error: `Интервал между публикациями меньше ${rules.minIntervalMinutes} мин`, code: "conflict",
      conflicts: conflicts.map((c) => ({ id: c.id, title: c.title, scheduled_at: c.scheduled_at })), warnings }, 409);
  }

  const { data: job, error } = await serviceClient().rpc("schedule_post_job", {
    p_owner: userId, p_post: post.id, p_run_at: runAt.toISOString(), p_expected_version: b.expected_version ?? null, p_approve_by: null,
  });
  if (error) {
    if (error.code === "40001") throw new HttpError(409, "Материал изменён в другой вкладке — обновите страницу", "version_conflict");
    if (error.code === "55000") throw new HttpError(409, "Публикация уже выполняется", "in_progress");
    throw new HttpError(422, error.message, "schedule_failed");
  }
  return json(req, { ok: true, run_at: runAt.toISOString(), job_id: (job as { id: string }).id, warnings });
});
