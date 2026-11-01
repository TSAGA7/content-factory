import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CalendarClock, Check, Copy, ExternalLink, History, ImagePlus, MessageSquare, RotateCcw, Save, Send, Trash2, X } from "lucide-react";
import { CAPABILITIES, composeText, FORMAT_LABELS, validatePostForPlatform, zonedToUtc, type PostFormat } from "@domain";
import { Badge, Button, Card, cx, errText, Input, Label, Modal, PlatformIcon, Select, Spinner, StatusBadge, Textarea, useToast } from "@/components/ui";
import { AiPanel } from "@/components/AiPanel";
import { MediaPicker } from "@/components/MediaPicker";
import { fmtDateTime, toLocalInput } from "@/lib/format";
import { signedUrl, useAccounts, useBrands } from "@/lib/queries";
import { ApiError, fn, must, rpc, supabase } from "@/lib/supabase";
import type { Media, Post } from "@/lib/types";

interface Draft { account_id: string; brand_id: string; format: PostFormat; title: string; body: string; hashtags: string; rubric: string; platform_options: Record<string, unknown> }
const toDraft = (p?: Partial<Post>): Draft => ({
  account_id: p?.account_id ?? "", brand_id: p?.brand_id ?? "", format: p?.format ?? "text", title: p?.title ?? "", body: p?.body ?? "",
  hashtags: (p?.hashtags ?? []).join(" "), rubric: p?.rubric ?? "", platform_options: p?.platform_options ?? {},
});
const parseTags = (s: string) => s.split(/[\s,]+/).map((t) => t.replace(/^#/, "").trim()).filter(Boolean);
const EDITABLE = ["draft", "generated", "review_required", "approved", "failed", "paused", "cancelled", "scheduled", "awaiting_credentials"];

export function EditorPage() {
  const { id } = useParams();
  const isNew = id === "new";
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const accounts = useAccounts().data ?? [];
  const brands = useBrands().data ?? [];

  const postQ = useQuery({ queryKey: ["post", id], enabled: !isNew, queryFn: async () => must(await supabase.from("content_posts").select("*").eq("id", id!).single()) as Post });
  const mediaQ = useQuery({ queryKey: ["post-media", id], enabled: !isNew, queryFn: async () => must(await supabase.from("post_media").select("position, role, media_assets(*)").eq("post_id", id!).order("position")) as unknown as { position: number; role: string; media_assets: Media }[] });
  const post = postQ.data;

  const [d, setD] = useState<Draft>(toDraft());
  const [media, setMedia] = useState<Media[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [modal, setModal] = useState<null | "media" | "schedule" | "copy" | "history" | "resolve">(null);

  useEffect(() => { if (post) { setD(toDraft(post)); setDirty(false); } }, [post?.id, post?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (mediaQ.data) setMedia(mediaQ.data.filter((r) => r.role === "main").map((r) => r.media_assets)); }, [mediaQ.data]);
  useEffect(() => {
    if (!isNew) return;
    const idea = sp.get("idea");
    if (idea) supabase.from("content_ideas").select("*").eq("id", idea).single().then(({ data }) => data && setD((x) => ({ ...x, title: data.title, rubric: data.rubric ?? "", account_id: data.account_id ?? x.account_id, brand_id: data.brand_id ?? x.brand_id, format: data.format ?? x.format, body: data.angle ? `${data.angle}\n\n` : x.body })));
  }, [isNew, sp]);

  const account = accounts.find((a) => a.id === d.account_id);
  const platform = account?.platform;
  const formats = platform ? (Object.keys(CAPABILITIES[platform].formats) as PostFormat[]) : (Object.keys(FORMAT_LABELS) as PostFormat[]);
  const issues = useMemo(() => {
    if (!platform) return [];
    const list = validatePostForPlatform(platform, { format: d.format, title: d.title, body: d.body, hashtags: parseTags(d.hashtags) }, media);
    return account?.connection_status === "mock" ? list.filter((i) => i.field !== "account") : list;
  }, [platform, d, media, account?.connection_status]);
  const textLen = composeText({ format: d.format, body: d.body, hashtags: parseTags(d.hashtags) }).length;
  const limit = platform ? CAPABILITIES[platform].formats[d.format]?.textLimit : undefined;
  const locked = post ? !EDITABLE.includes(post.status) : false;
  const tz = account?.timezone ?? "Europe/Moscow";

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setD((x) => ({ ...x, [k]: v })); setDirty(true); };
  const invalidate = () => { ["post", "posts", "stats", "post-media", "versions", "post-log"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };

  async function syncMedia(postId: string) {
    must(await supabase.from("post_media").delete().eq("post_id", postId).eq("role", "main"));
    if (media.length) must(await supabase.from("post_media").insert(media.map((m, i) => ({ post_id: postId, media_id: m.id, position: i, role: "main" }))));
  }

  async function save(extra: Partial<Post> = {}): Promise<Post | null> {
    setBusy("save");
    const row = { account_id: d.account_id || null, brand_id: d.brand_id || account?.brand_id || null, format: d.format, title: d.title || null, body: d.body,
      hashtags: parseTags(d.hashtags), rubric: d.rubric || null, platform_options: d.platform_options, timezone: tz, ...extra };
    try {
      let saved: Post;
      if (isNew) {
        const date = sp.get("date");
        saved = must(await supabase.from("content_posts").insert({ ...row, idea_id: sp.get("idea") || null, status: "draft" }).select().single()) as Post;
        await syncMedia(saved.id);
        if (sp.get("idea")) await supabase.from("content_ideas").update({ status: "used", post_id: saved.id }).eq("id", sp.get("idea")!);
        toast("Материал создан");
        nav(`/posts/${saved.id}${date ? `?date=${date}` : ""}`, { replace: true });
      } else {
        const r = await supabase.from("content_posts").update(row).eq("id", post!.id).eq("version", post!.version).select();
        if (r.error) throw new ApiError(r.error.message);
        if (!r.data?.length) { toast("Материал изменён в другом месте. Скопируйте правки и обновите страницу.", "err"); setBusy(null); return null; }
        saved = r.data[0] as Post;
        await syncMedia(saved.id);
        toast("Сохранено");
      }
      setDirty(false); invalidate(); setBusy(null);
      return saved;
    } catch (e) { toast(errText(e), "err"); setBusy(null); return null; }
  }

  async function setStatus(status: "approved" | "draft" | "review_required") {
    if (dirty || isNew) { const s = await save({ status } as Partial<Post>); if (s) toast(status === "approved" ? "Утверждено" : "Статус обновлён"); return; }
    setBusy(status);
    try { must(await supabase.from("content_posts").update({ status }).eq("id", post!.id)); toast(status === "approved" ? "Утверждено" : "Возвращено в черновики"); invalidate(); }
    catch (e) { toast(errText(e), "err"); }
    setBusy(null);
  }

  async function rpcAct(name: string, args: Record<string, unknown>, ok: string) {
    setBusy(name);
    try { await rpc(name, args); toast(ok); invalidate(); } catch (e) { toast(errText(e), "err"); }
    setBusy(null);
  }

  async function remove() {
    if (!confirm("Удалить материал безвозвратно?")) return;
    try { must(await supabase.from("post_media").delete().eq("post_id", post!.id)); must(await supabase.from("content_posts").delete().eq("id", post!.id)); invalidate(); nav("/posts"); toast("Удалено"); }
    catch (e) { toast(errText(e), "err"); }
  }

  if (!isNew && postQ.isLoading) return <Spinner />;
  if (!isNew && !post) return <p>Материал не найден. <Link className="text-indigo-600" to="/posts">К списку</Link></p>;

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => nav(-1)} className="rounded p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Назад"><ArrowLeft className="h-5 w-5" /></button>
          <h1 className="text-xl font-bold">{isNew ? "Новый материал" : "Редактор"}</h1>
          {post && <StatusBadge status={post.status} />}
          {post?.approved_by && <Badge tone="indigo">утвердил: {post.approved_by === "user" ? "вы" : "автопилот"}</Badge>}
          {post && <span className="text-xs text-slate-500">версия {post.version}</span>}
          {dirty && <Badge tone="amber">не сохранено</Badge>}
        </div>

        {post?.last_error && <Card className="border-l-4 border-rose-500"><p className="text-sm text-rose-700 dark:text-rose-300">{post.last_error}</p></Card>}
        {post?.status === "unknown_result" && (
          <Card className="border-l-4 border-amber-500">
            <p className="text-sm">Площадка не подтвердила результат. Откройте канал и проверьте, вышла ли публикация — повтор без проверки может создать дубль.</p>
            <div className="mt-2 flex flex-wrap gap-2">{account?.url && <a href={account.url} target="_blank" rel="noreferrer"><Button><ExternalLink className="h-4 w-4" />Открыть канал</Button></a>}<Button variant="primary" onClick={() => setModal("resolve")}>Отметить результат</Button></div>
          </Card>)}
        {post?.external_url && <a href={post.external_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-indigo-600"><ExternalLink className="h-4 w-4" />Открыть публикацию</a>}

        <Card>
          <fieldset disabled={locked} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Label label="Аккаунт"><Select value={d.account_id} onChange={(e) => { const a = accounts.find((x) => x.id === e.target.value); set("account_id", e.target.value); if (a) { const fm = Object.keys(CAPABILITIES[a.platform].formats) as PostFormat[]; if (!fm.includes(d.format)) set("format", fm[0]!); if (a.brand_id) set("brand_id", a.brand_id); } }}>
                <option value="">— выберите —</option>{accounts.map((a) => <option key={a.id} value={a.id}>{CAPABILITIES[a.platform].label}: {a.name}{a.connection_status === "mock" ? " (mock)" : ""}</option>)}</Select></Label>
              <Label label="Формат"><Select value={d.format} onChange={(e) => set("format", e.target.value as PostFormat)}>{formats.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f]}</option>)}</Select></Label>
              <Label label="Бренд"><Select value={d.brand_id} onChange={(e) => set("brand_id", e.target.value)}><option value="">—</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Label>
            </div>
            <Label label={platform === "youtube" ? "Заголовок видео" : "Заголовок (для себя)"}><Input value={d.title} maxLength={platform === "youtube" ? 100 : 300} onChange={(e) => set("title", e.target.value)} /></Label>
            <Label label={platform === "youtube" ? "Описание" : "Текст / подпись"} hint={limit !== undefined ? `${textLen} / ${limit || "—"} символов с хештегами` : `${textLen} символов`}>
              <Textarea rows={12} value={d.body} onChange={(e) => set("body", e.target.value)} className={cx(!!limit && textLen > limit && "ring-rose-500")} />
            </Label>
            <div className="grid gap-3 sm:grid-cols-2">
              <Label label="Хештеги" hint="Через пробел, без #"><Input value={d.hashtags} onChange={(e) => set("hashtags", e.target.value)} /></Label>
              <Label label="Рубрика"><Input list="rubrics" value={d.rubric} onChange={(e) => set("rubric", e.target.value)} /><datalist id="rubrics">{brands.find((b) => b.id === d.brand_id)?.rubrics.map((r) => <option key={r} value={r} />)}</datalist></Label>
            </div>
            {platform === "telegram" && (
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={Boolean(d.platform_options.disable_notification)} onChange={(e) => set("platform_options", { ...d.platform_options, disable_notification: e.target.checked })} />Без звука</label>
                {d.format === "text" && <label className="flex items-center gap-1.5"><input type="checkbox" checked={Boolean(d.platform_options.disable_preview)} onChange={(e) => set("platform_options", { ...d.platform_options, disable_preview: e.target.checked })} />Без превью ссылок</label>}
              </div>)}
          </fieldset>
        </Card>

        <Card title={`Медиа (${media.length})`} actions={!locked && <Button onClick={() => setModal("media")}><ImagePlus className="h-4 w-4" />Добавить</Button>}>
          {media.length === 0 ? <p className="text-sm text-slate-500">Без медиа{d.format !== "text" ? " — для этого формата нужен файл" : ""}.</p> : (
            <div className="flex flex-wrap gap-2">
              {media.map((m, i) => (
                <div key={m.id} className="relative">
                  <Thumb m={m} />
                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">{i + 1}</span>
                  {!locked && <div className="absolute right-1 top-1 flex gap-0.5">
                    {i > 0 && <button className="rounded bg-black/60 px-1 text-xs text-white" onClick={() => { const x = [...media]; [x[i - 1], x[i]] = [x[i]!, x[i - 1]!]; setMedia(x); setDirty(true); }} aria-label="Левее">←</button>}
                    <button className="rounded bg-black/60 p-0.5 text-white" onClick={() => { setMedia(media.filter((x) => x.id !== m.id)); setDirty(true); }} aria-label="Убрать"><X className="h-3 w-3" /></button></div>}
                </div>))}
            </div>)}
        </Card>

        {issues.length > 0 && (
          <Card title="Проверка площадки">
            <ul className="space-y-1 text-sm">{issues.map((i, k) => <li key={k} className={i.severity === "error" ? "text-rose-600" : "text-amber-600"}>• {i.message}</li>)}</ul>
          </Card>)}

        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap gap-2 border-t border-slate-200 bg-slate-50/95 p-3 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95 sm:mx-0 sm:rounded-xl sm:border">
          {!locked && <Button variant="primary" loading={busy === "save"} onClick={() => save()} disabled={!dirty && !isNew}><Save className="h-4 w-4" />Сохранить</Button>}
          {!locked && post?.status !== "approved" && post?.status !== "scheduled" && <Button loading={busy === "approved"} onClick={() => setStatus("approved")}><Check className="h-4 w-4" />Утвердить</Button>}
          {post && ["approved", "scheduled", "awaiting_credentials"].includes(post.status) && !dirty && <Button variant="primary" onClick={() => setModal("schedule")} disabled={issues.some((i) => i.severity === "error")}><CalendarClock className="h-4 w-4" />{post.status === "scheduled" ? "Перенести" : "Запланировать"}</Button>}
          {post && ["scheduled", "awaiting_credentials"].includes(post.status) && <Button loading={busy === "cancel_post_job"} onClick={() => rpcAct("cancel_post_job", { p_post: post.id }, "Снято с расписания")}>Снять с расписания</Button>}
          {post && post.status === "approved" && <Button onClick={() => setStatus("draft")}>В черновики</Button>}
          {post && post.status === "failed" && <Button loading={busy === "retry_post_job"} onClick={() => rpcAct("retry_post_job", { p_post: post.id }, "Повтор поставлен в очередь")}><RotateCcw className="h-4 w-4" />Повторить</Button>}
          {post && <Button variant="ghost" onClick={() => setModal("copy")}><Copy className="h-4 w-4" />Копия / адаптация</Button>}
          {post && <Button variant="ghost" onClick={() => setModal("history")}><History className="h-4 w-4" />История</Button>}
          {post && !["publishing", "published", "scheduled", "platform_scheduled", "unknown_result"].includes(post.status) && <Button variant="ghost" className="ml-auto text-rose-600" onClick={remove}><Trash2 className="h-4 w-4" /></Button>}
        </div>
      </div>

      <div className="space-y-4">
        <AiPanel post={post ?? null} draft={{ ...d, hashtags: parseTags(d.hashtags) }} platform={platform ?? null} disabled={locked}
          onApply={(p) => { setD((x) => ({ ...x, ...(p.title !== undefined ? { title: p.title } : {}), ...(p.body !== undefined ? { body: p.body } : {}), ...(p.hashtags ? { hashtags: p.hashtags.join(" ") } : {}) })); setDirty(true); }}
          onSaveFirst={async () => (isNew || dirty ? Boolean(await save()) : true)} />
        {post && <SidePanels post={post} />}
      </div>

      {modal === "media" && <MediaPicker selected={media.map((m) => m.id)} onClose={() => setModal(null)} onPick={(m) => { setMedia([...media, ...m.filter((x) => !media.some((y) => y.id === x.id))]); setDirty(true); setModal(null); }} />}
      {modal === "schedule" && post && <ScheduleModal post={post} tz={tz} defaultDate={sp.get("date")} onClose={() => { setModal(null); invalidate(); }} />}
      {modal === "copy" && post && <CopyModal post={post} media={media} onClose={() => setModal(null)} />}
      {modal === "history" && post && <HistoryModal post={post} onClose={() => setModal(null)} onRestore={(s) => { setD(toDraft(s as Partial<Post>)); setDirty(true); setModal(null); toast("Версия загружена в редактор — сохраните, чтобы применить"); }} />}
      {modal === "resolve" && post && <ResolveModal post={post} onClose={() => { setModal(null); invalidate(); }} />}
    </div>
  );
}

function Thumb({ m }: { m: Media }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { signedUrl(m.storage_path).then(setUrl); }, [m.storage_path]);
  return m.kind === "image"
    ? <img src={url ?? undefined} alt={m.file_name} className="h-24 w-24 rounded-lg bg-slate-200 object-cover dark:bg-slate-800" />
    : <video src={url ?? undefined} className="h-24 w-24 rounded-lg bg-black object-cover" muted />;
}

function ScheduleModal({ post, tz, defaultDate, onClose }: { post: Post; tz: string; defaultDate: string | null; onClose: () => void }) {
  const [mode, setMode] = useState<"at" | "next_slot" | "now">("at");
  const [at, setAt] = useState(post.scheduled_at ? toLocalInput(post.scheduled_at, tz) : defaultDate ? `${defaultDate}T12:00` : toLocalInput(new Date(Date.now() + 3600_000).toISOString(), tz));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ title: string | null; scheduled_at: string }[] | null>(null);
  const toast = useToast();
  async function go(force = false) {
    if (mode === "now" && !confirm("Опубликовать сейчас? Отменить после отправки будет нельзя.")) return;
    setBusy(true);
    try {
      let iso: string | undefined;
      if (mode === "at") { const [dd, tt] = at.split("T"); const [y, mo, da] = dd!.split("-").map(Number); const [h, mi] = tt!.split(":").map(Number); iso = zonedToUtc(y!, mo!, da!, h!, mi!, tz).toISOString(); }
      const r = await fn<{ run_at: string; warnings: string[] }>("posts-schedule", { post_id: post.id, mode, at: iso, expected_version: post.version, force });
      toast(`Запланировано на ${fmtDateTime(r.run_at, tz)}${r.warnings.length ? ". " + r.warnings.join("; ") : ""}`);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === "conflict") setConflict((e.data?.conflicts as never) ?? []);
      else toast(e instanceof ApiError && e.data?.issues ? (e.data.issues as { message: string }[]).map((i) => i.message).join("; ") : errText(e), "err");
    }
    setBusy(false);
  }
  return (
    <Modal open onClose={onClose} title="Запланировать публикацию">
      <div className="space-y-3">
        {(["at", "next_slot", "now"] as const).map((m) => (
          <label key={m} className="flex items-start gap-2 text-sm"><input type="radio" checked={mode === m} onChange={() => { setMode(m); setConflict(null); }} className="mt-1" />
            <span><b>{{ at: "На дату и время", next_slot: "В ближайший свободный слот", now: "Сейчас" }[m]}</b><br /><span className="text-slate-500">{{ at: `Время в поясе аккаунта (${tz})`, next_slot: "С учётом окон, лимитов и интервала автопилота", now: "Worker отправит в течение минуты" }[m]}</span></span></label>))}
        {mode === "at" && <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
        {conflict && (
          <div className="rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-950">
            <p className="font-medium">Рядом уже есть публикации этого аккаунта:</p>
            <ul className="mt-1 list-disc pl-5">{conflict.map((c, i) => <li key={i}>{fmtDateTime(c.scheduled_at, tz)} — {c.title ?? "без заголовка"}</li>)}</ul>
            <Button className="mt-2" onClick={() => go(true)} loading={busy}>Всё равно запланировать</Button>
          </div>)}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Отмена</Button><Button variant="primary" loading={busy} onClick={() => go()}><Send className="h-4 w-4" />Запланировать</Button></div>
      </div>
    </Modal>
  );
}

function CopyModal({ post, media, onClose }: { post: Post; media: Media[]; onClose: () => void }) {
  const accounts = useAccounts().data ?? [];
  const [ids, setIds] = useState<string[]>([]);
  const [adapt, setAdapt] = useState(true);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const nav = useNavigate();
  async function go() {
    setBusy(true);
    let made = 0; let last = "";
    for (const accId of ids) {
      const a = accounts.find((x) => x.id === accId)!;
      const fm = Object.keys(CAPABILITIES[a.platform].formats) as PostFormat[];
      let title = post.title, body = post.body, hashtags = post.hashtags;
      try {
        if (adapt) {
          const r = await fn<{ data: { title: string; body: string; hashtags: string[] } }>("ai-generate", { task: "adapt_platform", account_id: accId, platform: a.platform, format: fm.includes(post.format) ? post.format : fm[0], text: composeText(post), brand_id: a.brand_id ?? post.brand_id });
          title = r.data.title || title; body = r.data.body; hashtags = r.data.hashtags;
        }
        const np = must(await supabase.from("content_posts").insert({ account_id: accId, brand_id: a.brand_id ?? post.brand_id, parent_post_id: post.id, format: fm.includes(post.format) ? post.format : fm[0], title, body, hashtags, rubric: post.rubric, status: adapt ? "review_required" : "draft", timezone: a.timezone }).select().single()) as Post;
        if (media.length) must(await supabase.from("post_media").insert(media.map((m, i) => ({ post_id: np.id, media_id: m.id, position: i, role: "main" }))));
        made++; last = np.id;
      } catch (e) { toast(`${a.name}: ${errText(e)}`, "err"); }
    }
    setBusy(false);
    toast(`Создано копий: ${made}`);
    if (made === 1) nav(`/posts/${last}`); else onClose();
  }
  return (
    <Modal open onClose={onClose} title="Копия под другие аккаунты">
      <div className="max-h-72 space-y-1 overflow-y-auto">
        {accounts.filter((a) => a.id !== post.account_id).map((a) => (
          <label key={a.id} className="flex items-center gap-2 rounded p-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800"><input type="checkbox" checked={ids.includes(a.id)} onChange={() => setIds(ids.includes(a.id) ? ids.filter((x) => x !== a.id) : [...ids, a.id])} /><PlatformIcon platform={a.platform} />{a.name}</label>))}
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={adapt} onChange={(e) => setAdapt(e.target.checked)} />Адаптировать текст под площадку через Claude</label>
      <div className="mt-4 flex justify-end gap-2"><Button onClick={onClose}>Отмена</Button><Button variant="primary" disabled={!ids.length} loading={busy} onClick={go}>Создать ({ids.length})</Button></div>
    </Modal>
  );
}

function HistoryModal({ post, onClose, onRestore }: { post: Post; onClose: () => void; onRestore: (s: Record<string, unknown>) => void }) {
  const { data } = useQuery({ queryKey: ["versions", post.id], queryFn: async () => must(await supabase.from("content_versions").select("*").eq("post_id", post.id).order("version", { ascending: false })) as { id: string; version: number; snapshot: Record<string, unknown>; created_by: string; created_at: string }[] });
  return (
    <Modal open onClose={onClose} title="История версий" wide>
      {!data ? <Spinner /> : !data.length ? <p className="text-sm text-slate-500">Предыдущих версий нет.</p> : (
        <ul className="space-y-3">{data.map((v) => (
          <li key={v.id} className="rounded-lg p-3 ring-1 ring-slate-200 dark:ring-slate-700">
            <div className="flex items-center justify-between text-sm"><span>Версия {v.version} · {fmtDateTime(v.created_at)} · {v.created_by === "user" ? "вы" : "сервер"}</span><Button onClick={() => onRestore(v.snapshot)}>Восстановить</Button></div>
            <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{String(v.snapshot.body ?? "")}</p>
          </li>))}</ul>)}
    </Modal>
  );
}

function ResolveModal({ post, onClose }: { post: Post; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const toast = useToast();
  async function go(res: "published" | "retry" | "failed") {
    if (res === "retry" && !confirm("Повторить публикацию? Если она всё-таки вышла, появится дубль.")) return;
    try { await rpc("resolve_unknown_result", { p_post: post.id, p_resolution: res, p_url: url || null }); toast("Готово"); onClose(); } catch (e) { toast(errText(e), "err"); }
  }
  return (
    <Modal open onClose={onClose} title="Результат публикации">
      <p className="mb-3 text-sm text-slate-500">Проверьте канал и выберите, что произошло.</p>
      <Label label="Ссылка на публикацию (если вышла)"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://t.me/…" /></Label>
      <div className="mt-4 flex flex-wrap justify-end gap-2"><Button variant="danger" onClick={() => go("failed")}>Не вышла — ошибка</Button><Button onClick={() => go("retry")}>Не вышла — повторить</Button><Button variant="primary" onClick={() => go("published")}>Опубликовано</Button></div>
    </Modal>
  );
}

function SidePanels({ post }: { post: Post }) {
  const [text, setText] = useState("");
  const qc = useQueryClient();
  const toast = useToast();
  const comments = useQuery({ queryKey: ["comments", post.id], queryFn: async () => must(await supabase.from("post_comments").select("*").eq("post_id", post.id).order("created_at")) as { id: string; body: string; created_at: string }[] });
  const log = useQuery({ queryKey: ["post-log", post.id], queryFn: async () => must(await supabase.from("audit_logs").select("*").eq("entity_id", post.id).order("created_at", { ascending: false }).limit(30)) as { id: number; level: string; message: string; created_at: string }[] });
  const qr = post.quality_report;
  async function add() {
    if (!text.trim()) return;
    try { must(await supabase.from("post_comments").insert({ post_id: post.id, body: text.trim() })); setText(""); qc.invalidateQueries({ queryKey: ["comments", post.id] }); } catch (e) { toast(errText(e), "err"); }
  }
  return (
    <>
      {qr && (
        <Card title={<span className="flex items-center gap-2">AI-проверка <Badge tone={post.quality_passed ? "green" : "rose"}>{post.quality_score}/100</Badge></span>}>
          {qr.checked_version !== post.version && <p className="mb-2 text-xs text-amber-600">Проверка выполнялась для версии {qr.checked_version}</p>}
          {[...qr.programmatic ?? [], ...qr.problems].length > 0 && <ul className="mb-2 space-y-1 text-sm text-rose-600">{[...(qr.programmatic ?? []), ...qr.problems].map((p, i) => <li key={i}>• {p}</li>)}</ul>}
          {qr.unverified_claims.length > 0 && <><p className="text-xs font-medium text-amber-600">Проверьте факты:</p><ul className="mb-2 text-sm">{qr.unverified_claims.map((p, i) => <li key={i}>• {p}</li>)}</ul></>}
          <p className="text-sm text-slate-600 dark:text-slate-300">{qr.brand_fit}</p>
          {qr.suggestions.length > 0 && <ul className="mt-2 text-sm text-slate-500">{qr.suggestions.map((p, i) => <li key={i}>→ {p}</li>)}</ul>}
        </Card>)}
      <Card title={<span className="flex items-center gap-1.5"><MessageSquare className="h-4 w-4" />Комментарии</span>}>
        <ul className="mb-2 space-y-2 text-sm">{(comments.data ?? []).map((c) => <li key={c.id}><span className="text-xs text-slate-500">{fmtDateTime(c.created_at)}</span><p className="whitespace-pre-wrap">{c.body}</p></li>)}</ul>
        <div className="flex gap-2"><Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Заметка…" /><Button onClick={add}>OK</Button></div>
      </Card>
      <Card title="Журнал материала">
        {(log.data ?? []).length === 0 ? <p className="text-sm text-slate-500">Событий нет.</p> :
          <ul className="space-y-1.5 text-sm">{log.data!.map((e) => <li key={e.id} className={e.level === "error" ? "text-rose-600" : e.level === "warn" ? "text-amber-600" : ""}><span className="text-xs text-slate-500">{fmtDateTime(e.created_at)}</span> {e.message}</li>)}</ul>}
      </Card>
    </>
  );
}
