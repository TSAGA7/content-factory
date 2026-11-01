// Publishing engine: claims due jobs and drives them through the platform adapters.
import { adapterFor, type AdapterMedia, type PublishCtx } from "./adapters.ts";
import { loadCredentials } from "./crypto.ts";
import {
  backoffMs, evaluatePublish, localParts, parseRules, PublishError, validatePostForPlatform, zonedToUtc,
  type MediaInfo, type Platform,
} from "./domain.ts";
import { audit, notify, redact, type Db } from "./edge.ts";

interface Job {
  id: string; owner_id: string; post_id: string; account_id: string; platform: Platform; status: string; phase: string;
  attempts: number; max_attempts: number; external_call_started: boolean; reconcile_count: number;
  checkpoint: Record<string, unknown>;
}

class LeaseLost extends Error {}

export interface TickResult { claimed: number; succeeded: number; failed: number; deferred: number; manual: number; errors: string[] }

export async function runTick(db: Db, workerId: string, limit = 5): Promise<TickResult> {
  const res: TickResult = { claimed: 0, succeeded: 0, failed: 0, deferred: 0, manual: 0, errors: [] };
  const { data, error } = await db.rpc("claim_publishing_jobs", { p_worker: workerId, p_limit: limit, p_lease_seconds: 600 });
  if (error) throw new Error(`claim: ${error.message}`);
  const jobs = (data ?? []) as Job[];
  res.claimed = jobs.length;
  for (const job of jobs) {
    try {
      const outcome = await processJob(db, workerId, job);
      if (outcome === "succeeded") res.succeeded++;
      else if (outcome === "failed") res.failed++;
      else if (outcome === "manual") res.manual++;
      else res.deferred++;
    } catch (e) {
      res.errors.push(redact(String((e as Error).message)));
      console.error("job", job.id, redact(String((e as Error).stack ?? e)));
      if (!(e instanceof LeaseLost)) {
        await updJob(db, job, workerId, { status: "retry_wait", run_at: new Date(Date.now() + 5 * 60_000).toISOString(), last_error: redact(String((e as Error).message)), locked_by: null, locked_until: null }).catch(() => {});
      }
    }
  }
  await db.from("worker_heartbeats").upsert({ worker: "publish-worker", last_tick_at: new Date().toISOString(), last_result: res });
  return res;
}

async function updJob(db: Db, job: Job, workerId: string, patch: Record<string, unknown>) {
  const { data, error } = await db.from("publishing_jobs").update(patch).eq("id", job.id).eq("locked_by", workerId).select("id");
  if (error) throw new Error(`job update: ${error.message}`);
  if (!data?.length) throw new LeaseLost("lease lost");
}

const release = { locked_by: null, locked_until: null };

type Outcome = "succeeded" | "failed" | "deferred" | "manual";

async function processJob(db: Db, workerId: string, job: Job): Promise<Outcome> {
  const { data: post } = await db.from("content_posts").select("*").eq("id", job.post_id).maybeSingle();
  if (!post || post.status === "cancelled") {
    await updJob(db, job, workerId, { status: "cancelled", finished_at: new Date().toISOString(), ...release });
    return "failed";
  }
  const accountId = post.account_id ?? job.account_id;
  const { data: account } = await db.from("social_accounts").select("*").eq("id", accountId).maybeSingle();
  if (!account) {
    await failFinal(db, workerId, job, post, "validation", "Аккаунт удалён");
    return "failed";
  }
  const tz = account.timezone || "Europe/Moscow";

  const defer = async (reason: string, at: Date, status = "retry_wait") => {
    await updJob(db, job, workerId, { status, run_at: at.toISOString(), last_error: reason, ...release });
    await db.from("content_posts").update({ last_error: reason }).eq("id", post.id);
    return "deferred" as const;
  };

  if (account.is_paused) return defer("Аккаунт на паузе", new Date(Date.now() + 10 * 60_000));

  const adapter = adapterFor(account.platform, account.connection_status);
  if (!adapter) return failFinal(db, workerId, job, post, "validation", `Публикация в ${account.platform} ещё не подключена`);

  const isMock = account.connection_status === "mock";
  let credentials: Record<string, unknown> | null = null;
  if (!isMock) {
    if (account.connection_status !== "connected") {
      await block(db, workerId, job, post, account, `Аккаунт не подключён (${account.connection_status})`, "awaiting_credentials");
      return "manual";
    }
    credentials = await loadCredentials<Record<string, unknown>>(account.id);
    if (!credentials) {
      await block(db, workerId, job, post, account, "Нет сохранённых данных авторизации", "awaiting_credentials");
      return "manual";
    }
  }

  // media
  const { data: pm } = await db.from("post_media").select("position, role, media_assets(*)").eq("post_id", post.id).order("position");
  const media: AdapterMedia[] = [];
  for (const row of (pm ?? []) as unknown as { role: string; media_assets: MediaInfo & { storage_path: string; file_name: string } }[]) {
    if (row.role !== "main") continue;
    const m = row.media_assets;
    const { data: signed, error } = await db.storage.from("media").createSignedUrl(m.storage_path, 3600);
    if (error || !signed) {
      await db.from("media_assets").update({ status: "missing" }).eq("id", m.id);
      await audit(db, job.owner_id, "error", "media_unavailable", { type: "content_post", id: post.id }, `Файл «${m.file_name}» недоступен`);
      return failFinal(db, workerId, job, post, "media", `Файл «${m.file_name}» недоступен в хранилище`);
    }
    media.push({ ...m, signedUrl: signed.signedUrl });
  }

  const ctx: PublishCtx = {
    jobId: job.id,
    post: { id: post.id, format: post.format, title: post.title, body: post.body, hashtags: post.hashtags ?? [], platform_options: post.platform_options ?? {} },
    account: { id: account.id, external_id: account.external_id, handle: account.handle, connection_status: account.connection_status },
    media, credentials, checkpoint: { ...job.checkpoint },
    async saveCheckpoint(cp) {
      ctx.checkpoint = cp;
      const { data, error } = await db.from("publishing_jobs")
        .update({ checkpoint: cp, external_call_started: true })
        .eq("id", job.id).eq("locked_by", workerId).gt("locked_until", new Date().toISOString()).select("id");
      if (error || !data?.length) throw new LeaseLost("lease lost before external call");
    },
  };

  // ── reconcile path: the previous call may have reached the platform ──
  if (job.status === "reconcile" || job.checkpoint.unknown_result) {
    const rec = await adapter.reconcile(ctx);
    if (rec.kind === "found") return succeed(db, workerId, job, post, account, rec.externalId, rec.url, isMock);
    if (rec.kind === "indeterminate") {
      const maxReconcile = account.platform === "telegram" ? 0 : 3;
      if (job.reconcile_count < maxReconcile) {
        await updJob(db, job, workerId, { status: "reconcile", reconcile_count: job.reconcile_count + 1, run_at: new Date(Date.now() + 5 * 60_000).toISOString(), ...release });
        return "deferred";
      }
      return toManual(db, workerId, job, post, rec.reason);
    }
    // not_found → safe to publish again
  }

  // ── validation & rules (no attempt spent on deferral) ──
  const issues = validatePostForPlatform(account.platform, post, media).filter((i) => i.severity === "error");
  if (issues.length) return failFinal(db, workerId, job, post, "validation", issues.map((i) => i.message).join("; "));

  const { data: ruleRow } = await db.from("automation_rules").select("rules").eq("account_id", account.id).maybeSingle();
  const rules = parseRules(ruleRow?.rules ?? { mode: "approval" });
  const now = new Date();
  const lp = localParts(now, tz);
  const dayStart = zonedToUtc(lp.year, lp.month, lp.day, 0, 0, tz);
  const weekStart = zonedToUtc(lp.year, lp.month, lp.day - (lp.weekday - 1), 0, 0, tz);
  const { data: recent } = await db.from("publishing_results").select("published_at")
    .eq("account_id", account.id).eq("is_mock", false).gte("published_at", weekStart.toISOString()).order("published_at", { ascending: false });
  const pubs = (recent ?? []).map((r) => new Date(r.published_at as string));
  const decision = evaluatePublish(rules, post, {
    now, tz,
    publishedToday: pubs.filter((d) => d >= dayStart).length,
    publishedThisWeek: pubs.length,
    lastPublishedAt: pubs[0] ?? null,
  });
  if (!decision.ok) {
    if (decision.retryAt) return defer(decision.reason, decision.retryAt);
    await block(db, workerId, job, post, account, decision.reason, "failed");
    return "manual";
  }

  // ── publish ──
  const attemptNo = job.attempts + 1;
  await updJob(db, job, workerId, { attempts: attemptNo, phase: "publishing", status: "running" });
  await db.from("content_posts").update({ status: "publishing" }).eq("id", post.id);
  const { data: att } = await db.from("publishing_attempts").insert({ job_id: job.id, owner_id: job.owner_id, worker_id: workerId, step: "publish" }).select("id").single();
  const finishAttempt = (outcome: string, err?: PublishError) => db.from("publishing_attempts").update({
    outcome, finished_at: new Date().toISOString(), error_category: err?.category ?? null,
    error_message: err ? redact(err.message) : null, http_status: err?.opts.httpStatus ?? null,
  }).eq("id", att!.id);

  try {
    const out = await adapter.publish(ctx);
    if (out.kind === "published") {
      await finishAttempt("published");
      return succeed(db, workerId, job, post, account, out.externalId, out.url, Boolean(out.isMock));
    }
    if (out.kind === "in_progress") {
      await finishAttempt("in_progress");
      await updJob(db, job, workerId, { status: "continuing", checkpoint: out.checkpoint, run_at: new Date(Date.now() + out.runAfterSec * 1000).toISOString(), ...release });
      return "deferred";
    }
    await finishAttempt("platform_scheduled");
    await updJob(db, job, workerId, { status: "continuing", phase: "platform_scheduled", run_at: out.publishAt, ...release });
    await db.from("content_posts").update({ status: "platform_scheduled", external_id: out.externalId, external_url: out.url }).eq("id", post.id);
    return "deferred";
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    const err = e instanceof PublishError ? e : new PublishError("unknown_result", `Непредвиденная ошибка: ${(e as Error).message}`);
    // If the irreversible call has not been marked as started, network-like errors are safe to retry.
    if (err.category === "unknown_result" && !ctx.checkpoint.sending) err.category = "network";
    await finishAttempt("error", err);
    return handleError(db, workerId, { ...job, attempts: attemptNo }, post, account, err);
  }
}

async function succeed(db: Db, workerId: string, job: Job, post: { id: string }, account: { id: string; name: string }, externalId: string, url: string | null, isMock: boolean): Promise<Outcome> {
  const now = new Date().toISOString();
  const { error } = await db.from("publishing_results").upsert({
    job_id: job.id, post_id: post.id, account_id: account.id, owner_id: job.owner_id, external_id: externalId, external_url: url, is_mock: isMock, published_at: now,
  }, { onConflict: "job_id" });
  if (error) throw new Error(`result: ${error.message}`);
  await updJob(db, job, workerId, { status: "succeeded", phase: "done", finished_at: now, last_error: null, ...release });
  await db.from("content_posts").update({ status: "published", published_at: now, external_id: externalId, external_url: url, last_error: null }).eq("id", post.id);
  await db.from("social_accounts").update({ last_published_at: now, consecutive_failures: 0 }).eq("id", account.id);
  await audit(db, job.owner_id, "info", "post_published", { type: "content_post", id: post.id },
    `${isMock ? "[MOCK] " : ""}Опубликовано в «${account.name}»`, { external_id: externalId, url });
  return "succeeded";
}

async function toManual(db: Db, workerId: string, job: Job, post: { id: string; title?: string | null }, reason: string): Promise<Outcome> {
  await updJob(db, job, workerId, { status: "blocked", checkpoint: { ...job.checkpoint, unknown_result: true }, last_error: reason, last_error_category: "unknown_result", ...release });
  await db.from("content_posts").update({ status: "unknown_result", last_error: reason }).eq("id", post.id);
  await audit(db, job.owner_id, "warn", "unknown_result", { type: "content_post", id: post.id }, `Результат публикации неизвестен: ${reason}`);
  await notify(db, job.owner_id, "warn", "Проверьте публикацию вручную", `${post.title ?? "Материал"}: ${reason}. Откройте канал и отметьте результат.`, `/posts/${post.id}`);
  return "manual";
}

async function block(db: Db, workerId: string, job: Job, post: { id: string }, account: { id: string; name: string }, reason: string, postStatus: string) {
  await updJob(db, job, workerId, { status: "blocked", last_error: reason, ...release });
  await db.from("content_posts").update({ status: postStatus, last_error: reason }).eq("id", post.id);
  await audit(db, job.owner_id, "warn", "job_blocked", { type: "content_post", id: post.id }, `«${account.name}»: ${reason}`);
  await notify(db, job.owner_id, "warn", `Публикация остановлена: ${account.name}`, reason, `/posts/${post.id}`);
}

async function failFinal(db: Db, workerId: string, job: Job, post: { id: string }, category: string, reason: string): Promise<Outcome> {
  await updJob(db, job, workerId, { status: "failed", last_error: reason, last_error_category: category, finished_at: new Date().toISOString(), ...release });
  await db.from("content_posts").update({ status: "failed", last_error: reason }).eq("id", post.id);
  await audit(db, job.owner_id, "error", "publish_failed", { type: "content_post", id: post.id }, reason, { category });
  await notify(db, job.owner_id, "error", "Ошибка публикации", reason, `/posts/${post.id}`);
  return "failed";
}

async function handleError(db: Db, workerId: string, job: Job, post: { id: string; title?: string | null }, account: { id: string; name: string; consecutive_failures: number }, err: PublishError): Promise<Outcome> {
  const msg = redact(err.message);
  await db.from("social_accounts").update({ last_error: msg, last_error_at: new Date().toISOString() }).eq("id", account.id);
  switch (err.category) {
    case "rate_limit":
    case "quota": {
      // limits do not consume attempts
      const at = new Date(Date.now() + (err.opts.retryAfterSec ?? 3600) * 1000);
      await updJob(db, job, workerId, { status: "retry_wait", attempts: job.attempts - 1, run_at: at.toISOString(), last_error: msg, last_error_category: err.category, ...release });
      await db.from("content_posts").update({ status: "scheduled", last_error: msg }).eq("id", post.id);
      return "deferred";
    }
    case "auth":
    case "permission": {
      await db.from("social_accounts").update({ connection_status: err.category === "auth" ? "expired" : "insufficient_permissions" }).eq("id", account.id);
      await updJob(db, job, workerId, { last_error_category: err.category });
      await block(db, workerId, job, post, account, msg, "awaiting_credentials");
      return "manual";
    }
    case "unknown_result":
      return toManual(db, workerId, job, post, msg);
    case "network":
    case "platform": {
      if ((err.category === "network" || err.opts.retryable) && job.attempts < job.max_attempts) {
        const at = new Date(Date.now() + backoffMs(job.attempts));
        await updJob(db, job, workerId, { status: "retry_wait", run_at: at.toISOString(), last_error: msg, last_error_category: err.category, external_call_started: false, checkpoint: {}, ...release });
        await db.from("content_posts").update({ status: "scheduled", last_error: `${msg} — повтор ${at.toISOString()}` }).eq("id", post.id);
        return "deferred";
      }
      break;
    }
  }
  const failures = (account.consecutive_failures ?? 0) + 1;
  await db.from("social_accounts").update({ consecutive_failures: failures }).eq("id", account.id);
  const { data: ruleRow } = await db.from("automation_rules").select("rules").eq("account_id", account.id).maybeSingle();
  const rules = parseRules(ruleRow?.rules ?? {});
  if (rules.onError === "pause_account" || failures >= rules.pauseAfterConsecutiveFailures) {
    await db.from("social_accounts").update({ is_paused: true }).eq("id", account.id);
    await notify(db, job.owner_id, "error", `Аккаунт «${account.name}» приостановлен`, `${failures} ошибок подряд. Последняя: ${msg}`, `/accounts`);
  }
  return failFinal(db, workerId, job, post, err.category, msg);
}
