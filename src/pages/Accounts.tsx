import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, ExternalLink, FlaskConical, Pause, Play, Plus, RefreshCw, Settings2, Trash2, Unplug } from "lucide-react";
import { automationRulesSchema, CAPABILITIES, FORMAT_LABELS, MODE_LABELS, parseRules, type AutomationRules, type Platform, type PostFormat } from "@domain";
import { PageHeader } from "@/components/AppShell";
import { Badge, Button, Card, ConnBadge, Empty, errText, Input, Label, Modal, PlatformIcon, Select, Spinner, useToast } from "@/components/ui";
import { fmtAgo, TIMEZONES } from "@/lib/format";
import { useAccounts, useBrands } from "@/lib/queries";
import { fn, must, rpc, supabase } from "@/lib/supabase";
import type { Account } from "@/lib/types";

export function AccountsPage() {
  const { data: accounts, isLoading } = useAccounts();
  const brands = useBrands().data ?? [];
  const [modal, setModal] = useState<null | "telegram" | "mock" | { edit: Account } | { rules: Account }>(null);
  const [filter, setFilter] = useState({ platform: "", brand: "", status: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => { qc.invalidateQueries({ queryKey: ["accounts"] }); qc.invalidateQueries({ queryKey: ["stats"] }); };

  async function act(a: Account, what: "check" | "pause" | "resume" | "disconnect" | "delete") {
    if (what === "disconnect" && !confirm(`Отключить «${a.name}»? Токен будет удалён из базы.`)) return;
    if (what === "delete" && !confirm(`Удалить аккаунт «${a.name}» вместе с его очередью? Материалы останутся без аккаунта.`)) return;
    setBusy(a.id + what);
    try {
      if (what === "check" || what === "disconnect") { const r = await fn<{ ok: boolean; message: string }>("accounts-connect", { action: what, account_id: a.id }); toast(r.message, r.ok ? "ok" : "err"); }
      else if (what === "delete") { must(await supabase.from("social_accounts").delete().eq("id", a.id)); toast("Аккаунт удалён"); }
      else { await rpc("set_account_paused", { p_account: a.id, p_paused: what === "pause" }); toast(what === "pause" ? "Аккаунт на паузе — публикации будут ждать" : "Аккаунт возобновлён"); }
      refresh();
    } catch (e) { toast(errText(e), "err"); }
    setBusy(null);
  }

  const list = (accounts ?? []).filter((a) => (!filter.platform || a.platform === filter.platform) && (!filter.brand || a.brand_id === filter.brand) && (!filter.status || a.connection_status === filter.status));

  return (
    <>
      <PageHeader title="Аккаунты" sub="Площадки, подключения и правила автопилота" actions={<>
        <Button variant="primary" onClick={() => setModal("telegram")}><Bot className="h-4 w-4" />Подключить Telegram</Button>
        <Button onClick={() => setModal("mock")}><FlaskConical className="h-4 w-4" />Тестовый аккаунт</Button>
      </>} />
      <Card className="mb-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">Сейчас публикация работает в <b>Telegram</b>. Instagram, YouTube и Threads подключаются через OAuth и появятся в следующей версии — их можно уже добавить тестовыми аккаунтами для планирования.</p>
      </Card>
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Select value={filter.platform} onChange={(e) => setFilter({ ...filter, platform: e.target.value })}><option value="">Все площадки</option>{Object.entries(CAPABILITIES).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}</Select>
        <Select value={filter.brand} onChange={(e) => setFilter({ ...filter, brand: e.target.value })}><option value="">Все бренды</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
        <Select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}><option value="">Любой статус</option><option value="connected">Подключён</option><option value="mock">Тестовый</option><option value="insufficient_permissions">Нет прав</option><option value="expired">Токен истёк</option><option value="revoked">Отключён</option><option value="error">Ошибка</option></Select>
      </div>
      {isLoading ? <Spinner /> : !list.length ? <Empty title="Аккаунтов нет" text="Подключите Telegram-канал через своего бота." /> : (
        <div className="grid gap-3 lg:grid-cols-2">
          {list.map((a) => (
            <Card key={a.id}>
              <div className="flex items-start gap-3">
                <PlatformIcon platform={a.platform} className="h-9 w-9 text-xs" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{a.name}</span><ConnBadge status={a.connection_status} />{a.is_paused && <Badge tone="amber">Пауза</Badge>}</div>
                  <div className="mt-0.5 text-xs text-slate-500">{a.handle ?? a.external_id ?? "—"} · {brands.find((b) => b.id === a.brand_id)?.name ?? "без бренда"} · {a.timezone}</div>
                  <div className="mt-0.5 text-xs text-slate-500">Проверка: {fmtAgo(a.last_checked_at)} · последняя публикация: {fmtAgo(a.last_published_at)}</div>
                  {a.last_error && <p className="mt-1 text-xs text-rose-600">{a.last_error}</p>}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {a.url && <a href={a.url} target="_blank" rel="noreferrer"><Button variant="ghost"><ExternalLink className="h-4 w-4" />Открыть</Button></a>}
                <Button variant="ghost" loading={busy === a.id + "check"} onClick={() => act(a, "check")}><RefreshCw className="h-4 w-4" />Проверить</Button>
                <Button variant="ghost" onClick={() => setModal({ rules: a })}><Settings2 className="h-4 w-4" />Автопилот</Button>
                <Button variant="ghost" onClick={() => setModal({ edit: a })}>Изменить</Button>
                {a.is_paused ? <Button variant="ghost" onClick={() => act(a, "resume")}><Play className="h-4 w-4" />Возобновить</Button> : <Button variant="ghost" onClick={() => act(a, "pause")}><Pause className="h-4 w-4" />Пауза</Button>}
                {a.platform === "telegram" && a.connection_status !== "mock" && a.connection_status !== "revoked" && <Button variant="ghost" onClick={() => act(a, "disconnect")}><Unplug className="h-4 w-4" />Отключить</Button>}
                {a.platform === "telegram" && a.connection_status === "revoked" && <Button variant="ghost" onClick={() => setModal("telegram")}>Подключить заново</Button>}
                <Button variant="ghost" className="text-rose-600" onClick={() => act(a, "delete")}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </Card>))}
        </div>)}
      {modal === "telegram" && <TelegramModal onClose={() => { setModal(null); refresh(); }} />}
      {modal === "mock" && <MockModal onClose={() => { setModal(null); refresh(); }} />}
      {modal && typeof modal === "object" && "edit" in modal && <EditModal account={modal.edit} onClose={() => { setModal(null); refresh(); }} />}
      {modal && typeof modal === "object" && "rules" in modal && <RulesModal account={modal.rules} onClose={() => setModal(null)} />}
    </>
  );
}

function TelegramModal({ onClose }: { onClose: () => void }) {
  const brands = useBrands().data ?? [];
  const [f, setF] = useState({ bot_token: "", chat: "", name: "", brand_id: "", timezone: "Europe/Moscow" });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const toast = useToast();
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setResult(null);
    try {
      const r = await fn<{ ok: boolean; message: string }>("accounts-connect", { action: "telegram", bot_token: f.bot_token.trim(), chat: f.chat.trim(), name: f.name || undefined, brand_id: f.brand_id || null, timezone: f.timezone });
      setResult(r);
      if (r.ok) { toast("Канал подключён"); onClose(); }
    } catch (err) { setResult({ ok: false, message: errText(err) }); }
    setBusy(false);
  }
  return (
    <Modal open onClose={onClose} title="Подключить Telegram-канал">
      <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
        <li>В <a className="text-indigo-600" href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> создайте бота командой /newbot и скопируйте токен.</li>
        <li>Добавьте бота в администраторы канала с правом «Публикация сообщений».</li>
        <li>Укажите @username канала (или числовой ID для приватного, вида -100…).</li>
      </ol>
      <form onSubmit={submit} className="space-y-3">
        <Label label="Токен бота" hint="Хранится зашифрованным и не возвращается в браузер"><Input required autoComplete="off" placeholder="123456789:AA…" value={f.bot_token} onChange={(e) => setF({ ...f, bot_token: e.target.value })} /></Label>
        <Label label="Канал"><Input required placeholder="@my_channel" value={f.chat} onChange={(e) => setF({ ...f, chat: e.target.value })} /></Label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Label label="Название (необязательно)"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Label>
          <Label label="Бренд"><Select value={f.brand_id} onChange={(e) => setF({ ...f, brand_id: e.target.value })}><option value="">Без бренда</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Label>
        </div>
        <Label label="Часовой пояс аккаунта"><Select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>{TIMEZONES.map((t) => <option key={t}>{t}</option>)}</Select></Label>
        {result && <p className={result.ok ? "text-sm text-emerald-600" : "text-sm text-rose-600"}>{result.message}</p>}
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Закрыть</Button><Button variant="primary" loading={busy}>Проверить и подключить</Button></div>
      </form>
    </Modal>
  );
}

function MockModal({ onClose }: { onClose: () => void }) {
  const brands = useBrands().data ?? [];
  const [f, setF] = useState({ name: "", platform: "telegram" as Platform, brand_id: "", timezone: "Europe/Moscow" });
  const toast = useToast();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      must(await supabase.from("social_accounts").insert({ name: f.name, platform: f.platform, brand_id: f.brand_id || null, timezone: f.timezone, connection_status: "mock" }));
      toast("Тестовый аккаунт создан"); onClose();
    } catch (err) { toast(errText(err), "err"); }
  }
  return (
    <Modal open onClose={onClose} title="Тестовый аккаунт (mock)">
      <p className="mb-3 text-sm text-slate-500">Публикации в mock-аккаунт никуда не отправляются, но проходят через очередь и журнал с пометкой [MOCK]. Удобно для проверки календаря и автопилота.</p>
      <form onSubmit={submit} className="space-y-3">
        <Label label="Название"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Label label="Площадка"><Select value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value as Platform })}>{Object.entries(CAPABILITIES).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}</Select></Label>
          <Label label="Бренд"><Select value={f.brand_id} onChange={(e) => setF({ ...f, brand_id: e.target.value })}><option value="">Без бренда</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Label>
        </div>
        <Label label="Часовой пояс"><Select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>{TIMEZONES.map((t) => <option key={t}>{t}</option>)}</Select></Label>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Отмена</Button><Button variant="primary"><Plus className="h-4 w-4" />Создать</Button></div>
      </form>
    </Modal>
  );
}

function EditModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const brands = useBrands().data ?? [];
  const [f, setF] = useState({ name: account.name, brand_id: account.brand_id ?? "", timezone: account.timezone });
  const toast = useToast();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try { must(await supabase.from("social_accounts").update({ name: f.name, brand_id: f.brand_id || null, timezone: f.timezone }).eq("id", account.id)); toast("Сохранено"); onClose(); }
    catch (err) { toast(errText(err), "err"); }
  }
  return (
    <Modal open onClose={onClose} title="Аккаунт">
      <form onSubmit={submit} className="space-y-3">
        <Label label="Название"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Label>
        <Label label="Бренд"><Select value={f.brand_id} onChange={(e) => setF({ ...f, brand_id: e.target.value })}><option value="">Без бренда</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Label>
        <Label label="Часовой пояс" hint="Окна автопилота и время в редакторе считаются в этом поясе"><Select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>{TIMEZONES.map((t) => <option key={t}>{t}</option>)}</Select></Label>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Отмена</Button><Button variant="primary">Сохранить</Button></div>
      </form>
    </Modal>
  );
}

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function RulesModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const [rules, setRules] = useState<AutomationRules | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const formats = Object.keys(CAPABILITIES[account.platform].formats) as PostFormat[];
  useEffect(() => { supabase.from("automation_rules").select("rules").eq("account_id", account.id).maybeSingle().then(({ data }) => setRules(parseRules(data?.rules ?? { mode: "approval" }))); }, [account.id]);
  if (!rules) return <Modal open onClose={onClose} title="Автопилот"><Spinner /></Modal>;
  const set = (p: Partial<AutomationRules>) => setRules({ ...rules, ...p });
  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  async function save() {
    const parsed = automationRulesSchema.safeParse(rules);
    if (!parsed.success) { toast("Проверьте поля: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "), "err"); return; }
    if ((rules!.mode === "limited" || rules!.mode === "extended") && !rules!.allowedFormats.length) { toast("Для автопилота выберите разрешённые форматы", "err"); return; }
    setBusy(true);
    try { must(await supabase.from("automation_rules").upsert({ account_id: account.id, rules: parsed.data })); toast("Правила сохранены"); onClose(); }
    catch (e) { toast(errText(e), "err"); }
    setBusy(false);
  }

  return (
    <Modal open onClose={onClose} title={`Автопилот: ${account.name}`} wide>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(Object.keys(MODE_LABELS) as AutomationRules["mode"][]).map((m) => (
            <button key={m} type="button" onClick={() => set({ mode: m })} className={`rounded-lg p-3 text-left text-sm ring-1 ${rules.mode === m ? "bg-indigo-50 ring-2 ring-indigo-500 dark:bg-indigo-950" : "ring-slate-300 dark:ring-slate-700"}`}>
              <div className="font-medium">{MODE_LABELS[m]}</div>
              <div className="mt-0.5 text-xs text-slate-500">{{ manual: "Только подготовка", approval: "Публикуется утверждённое вами", limited: "Автоутверждение разрешённых форматов", extended: "Плюс автопланирование" }[m]}</div>
            </button>))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Label label="Автопилот может публиковать форматы"><div className="flex flex-wrap gap-2">{formats.map((f) => <label key={f} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={rules.allowedFormats.includes(f)} onChange={() => set({ allowedFormats: toggle(rules.allowedFormats, f) })} />{FORMAT_LABELS[f]}</label>)}</div></Label>
          <Label label="Всегда требуют человека"><div className="flex flex-wrap gap-2">{formats.map((f) => <label key={f} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={rules.manualApprovalFormats.includes(f)} onChange={() => set({ manualApprovalFormats: toggle(rules.manualApprovalFormats, f) })} />{FORMAT_LABELS[f]}</label>)}</div></Label>
          <Label label="Максимум в день"><Input type="number" min={0} max={100} value={rules.maxPerDay} onChange={(e) => set({ maxPerDay: +e.target.value })} /></Label>
          <Label label="Максимум в неделю"><Input type="number" min={0} max={700} value={rules.maxPerWeek} onChange={(e) => set({ maxPerWeek: +e.target.value })} /></Label>
          <Label label="Минимальный интервал, мин"><Input type="number" min={0} value={rules.minIntervalMinutes} onChange={(e) => set({ minIntervalMinutes: +e.target.value })} /></Label>
          <Label label="Минимальная оценка качества"><Input type="number" min={0} max={100} value={rules.minQualityScore} onChange={(e) => set({ minQualityScore: +e.target.value })} /></Label>
          <Label label="При ошибке"><Select value={rules.onError} onChange={(e) => set({ onError: e.target.value as AutomationRules["onError"] })}><option value="retry">Повторять по правилам</option><option value="pause_account">Сразу ставить аккаунт на паузу</option><option value="notify_only">Только уведомлять</option></Select></Label>
          <Label label="Пауза после ошибок подряд"><Input type="number" min={1} max={50} value={rules.pauseAfterConsecutiveFailures} onChange={(e) => set({ pauseAfterConsecutiveFailures: +e.target.value })} /></Label>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rules.requireQualityPass} onChange={(e) => set({ requireQualityPass: e.target.checked })} />Автоутверждение только после успешной AI-проверки</label>
        <Label label={`Окна публикаций (пояс ${account.timezone}). Пусто — в любое время`}>
          <div className="space-y-2">
            {rules.timeWindows.map((w, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-2 dark:bg-slate-800">
                {DAYS.map((d, di) => <label key={d} className="flex items-center gap-0.5 text-xs"><input type="checkbox" checked={w.days.includes(di + 1)} onChange={() => { const tw = [...rules.timeWindows]; tw[i] = { ...w, days: w.days.includes(di + 1) ? w.days.filter((x) => x !== di + 1) : [...w.days, di + 1].sort() }; set({ timeWindows: tw }); }} />{d}</label>)}
                <Input type="time" className="w-28" value={w.from} onChange={(e) => { const tw = [...rules.timeWindows]; tw[i] = { ...w, from: e.target.value }; set({ timeWindows: tw }); }} />–
                <Input type="time" className="w-28" value={w.to} onChange={(e) => { const tw = [...rules.timeWindows]; tw[i] = { ...w, to: e.target.value }; set({ timeWindows: tw }); }} />
                <Button variant="ghost" onClick={() => set({ timeWindows: rules.timeWindows.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
              </div>))}
            <Button type="button" onClick={() => set({ timeWindows: [...rules.timeWindows, { days: [1, 2, 3, 4, 5], from: "10:00", to: "20:00" }] })}><Plus className="h-4 w-4" />Окно</Button>
          </div>
        </Label>
        <Label label="Запретные даты" hint="ГГГГ-ММ-ДД, по одной на строку"><textarea className="w-full rounded-lg px-3 py-2 text-sm ring-1 ring-slate-300 dark:bg-slate-800 dark:ring-slate-600" rows={2} value={rules.blackoutDates.join("\n")} onChange={(e) => set({ blackoutDates: e.target.value.split(/\s+/).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) })} /></Label>
        <p className="text-xs text-slate-500">Правила проверяются на сервере перед каждой публикацией. Если время вне окна или достигнут лимит — публикация переносится на ближайшее разрешённое время.</p>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Отмена</Button><Button variant="primary" loading={busy} onClick={save}>Сохранить</Button></div>
      </div>
    </Modal>
  );
}
