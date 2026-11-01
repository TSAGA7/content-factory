// AI Studio endpoint: runs a Claude task with brand context and stores results where appropriate.
import { z } from "zod";
import { runAi, programmaticChecks, type AiTask, type Brand } from "../_shared/ai.ts";
import { composeText, zonedToUtc, type Platform } from "../_shared/domain.ts";
import { audit, handler, HttpError, json, readJson, requireUser, serviceClient } from "../_shared/edge.ts";

const Body = z.object({
  task: z.enum(["content_plan", "generate_post", "rewrite", "shorten", "expand", "change_tone", "adapt_platform", "variants", "quality_check", "reel_script", "youtube_metadata"]),
  brand_id: z.string().uuid().nullish(),
  account_id: z.string().uuid().nullish(),
  account_ids: z.array(z.string().uuid()).max(50).optional(),
  post_id: z.string().uuid().nullish(),
  format: z.string().nullish(),
  platform: z.enum(["telegram", "instagram", "youtube", "threads"]).nullish(),
  topic: z.string().max(4000).optional(),
  text: z.string().max(20000).optional(),
  tone: z.string().max(200).optional(),
  count: z.number().int().min(2).max(5).optional(),
  period: z.object({ from: z.string(), to: z.string() }).optional(),
  per_week: z.number().int().min(1).max(50).optional(),
  notes: z.string().max(4000).optional(),
});

export default handler(async (req) => {
  const { userId, userClient } = await requireUser(req);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, "Некорректные параметры: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "), "bad_request");
  const b = parsed.data;
  const db = serviceClient();

  let post: Record<string, unknown> | null = null;
  if (b.post_id) {
    const { data } = await userClient.from("content_posts").select("*").eq("id", b.post_id).maybeSingle();
    if (!data) throw new HttpError(404, "Материал не найден", "not_found");
    post = data;
  }
  let account: { id: string; platform: Platform; name: string; brand_id: string | null; timezone: string } | null = null;
  const accId = b.account_id ?? (post?.account_id as string | undefined);
  if (accId) {
    const { data } = await userClient.from("social_accounts").select("id, platform, name, brand_id, timezone").eq("id", accId).maybeSingle();
    account = data;
  }
  const brandId = b.brand_id ?? (post?.brand_id as string | undefined) ?? account?.brand_id ?? null;
  let brand: Brand | null = null;
  if (brandId) {
    const { data } = await userClient.from("brands").select("*").eq("id", brandId).maybeSingle();
    brand = data;
  }
  const platform = (b.platform ?? account?.platform ?? null) as Platform | null;
  const format = b.format ?? (post?.format as string | undefined) ?? null;
  const currentText = b.text ?? (post ? composeText({ format: post.format as never, body: String(post.body ?? ""), hashtags: post.hashtags as string[] }) : "");
  const task = b.task as AiTask;

  let payload = "";
  if (task === "content_plan") {
    if (!b.period || !b.account_ids?.length) throw new HttpError(400, "Укажите период и аккаунты", "bad_request");
    const { data: accs } = await userClient.from("social_accounts").select("id, name, platform, timezone, brand_id").in("id", b.account_ids);
    if (!accs?.length) throw new HttpError(400, "Аккаунты не найдены", "bad_request");
    payload = `Период: ${b.period.from} — ${b.period.to}. Публикаций в неделю на аккаунт: ${b.per_week ?? 3}.\nАккаунты:\n` +
      accs.map((a) => `- account_id=${a.id}; «${a.name}»; площадка ${a.platform}; пояс ${a.timezone}`).join("\n") +
      (b.notes ? `\nПожелания: ${b.notes}` : "");
  } else if (["generate_post", "variants", "reel_script", "youtube_metadata"].includes(task)) {
    payload = `Тема/задача: ${b.topic ?? post?.title ?? ""}\n${currentText ? `Текущий черновик:\n${currentText}\n` : ""}${b.notes ? `Пожелания: ${b.notes}\n` : ""}${b.count ? `Количество вариантов: ${b.count}` : ""}`;
  } else {
    if (!currentText.trim()) throw new HttpError(400, "Нет текста для обработки", "bad_request");
    payload = `${task === "change_tone" ? `Новая тональность: ${b.tone ?? "дружелюбная"}\n` : ""}${b.notes ? `Пожелания: ${b.notes}\n` : ""}Текст:\n${currentText}`;
  }

  const result = await runAi(db, userId, task, { brand, platform, format, payload, postId: (post?.id as string) ?? null });

  // Post-processing
  if (task === "content_plan") {
    const items = (result.data as { items: { date: string; time: string; account_id: string; format: string; rubric: string; topic: string; angle: string }[] }).items;
    const { data: accs } = await userClient.from("social_accounts").select("id, timezone, brand_id").in("id", b.account_ids!);
    const byId = new Map((accs ?? []).map((a) => [a.id, a]));
    const rows = items.filter((i) => byId.has(i.account_id)).map((i) => {
      const a = byId.get(i.account_id)!;
      const [y, m, d] = i.date.split("-").map(Number);
      const [hh, mm] = (i.time || "12:00").split(":").map(Number);
      const plannedAt = y && m && d ? zonedToUtc(y, m, d, hh ?? 12, mm ?? 0, a.timezone).toISOString() : null;
      const allowed = ["text", "photo", "video", "album", "carousel", "reel", "story", "short", "long_video", "thread"];
      return { owner_id: userId, brand_id: a.brand_id ?? brandId, account_id: a.id, title: i.topic, angle: i.angle, rubric: i.rubric,
        format: allowed.includes(i.format) ? i.format : null, planned_at: plannedAt, source: "ai_plan" };
    });
    const skipped = items.length - rows.length;
    const { error } = await db.from("content_ideas").insert(rows);
    if (error) throw new HttpError(500, "Не удалось сохранить план: " + error.message);
    await audit(db, userId, "info", "ai_plan_created", null, `Контент-план: ${rows.length} идей${skipped ? `, отброшено ${skipped} с неизвестными аккаунтами` : ""}`);
    return json(req, { ok: true, task, created: rows.length, skipped, runId: result.runId, costUsd: result.costUsd });
  }

  if (task === "quality_check" && post) {
    const qc = result.data as { score: number; passed: boolean; problems: string[]; unverified_claims: string[]; brand_fit: string; suggestions: string[] };
    const { data: recent } = await userClient.from("content_posts").select("body").eq("account_id", post.account_id ?? "").eq("status", "published")
      .neq("id", post.id).order("published_at", { ascending: false }).limit(30);
    const prog = programmaticChecks(currentText, brand, (recent ?? []).map((r) => r.body as string));
    const passed = qc.passed && prog.length === 0;
    const score = prog.length ? Math.min(qc.score, 49) : qc.score;
    const report = { ...qc, programmatic: prog, checked_version: post.version, run_id: result.runId };
    await db.from("content_posts").update({ quality_score: score, quality_passed: passed, quality_report: report }).eq("id", post.id);
    return json(req, { ok: true, task, data: { ...report, score, passed }, runId: result.runId, costUsd: result.costUsd });
  }

  return json(req, { ok: true, task, data: result.data, runId: result.runId, costUsd: result.costUsd });
});
