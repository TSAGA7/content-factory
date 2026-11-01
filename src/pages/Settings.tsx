import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, OctagonX, Play } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { Badge, Button, Card, errText, Input, Label, Spinner, useToast } from "@/components/ui";
import { useSettings } from "@/lib/queries";
import { fn, must, rpc, supabase } from "@/lib/supabase";

export function SettingsPage() {
  const { data: s, isLoading } = useSettings();
  const ai = useQuery({ queryKey: ["app-settings"], queryFn: () => fn<{ anthropic: { configured: boolean; hint?: string }; pricing_configured: boolean; model_default: string }>("app-settings", { action: "status" }) });
  const [key, setKey] = useState("");
  const [budget, setBudget] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => { if (s) { setBudget(String(s.ai_monthly_budget_usd)); setModel(s.ai_model ?? ""); } }, [s]);

  async function wrap(name: string, f: () => Promise<void>) { setBusy(name); try { await f(); } catch (e) { toast(errText(e), "err"); } setBusy(null); }

  if (isLoading || !s) return <Spinner />;
  return (
    <>
      <PageHeader title="Настройки" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Аварийная остановка" className={s.emergency_stop ? "ring-2 ring-rose-500" : ""}>
          <p className="text-sm text-slate-600 dark:text-slate-300">Останавливает захват новых задач очереди для всех аккаунтов. Запросы, уже отправленные площадке, отменить невозможно.</p>
          <div className="mt-3">{s.emergency_stop
            ? <Button variant="primary" loading={busy === "stop"} onClick={() => wrap("stop", async () => { await rpc("set_emergency_stop", { p_on: false }); qc.invalidateQueries(); toast("Публикации возобновлены"); })}><Play className="h-4 w-4" />Возобновить публикации</Button>
            : <Button variant="danger" loading={busy === "stop"} onClick={() => confirm("Остановить все публикации?") && wrap("stop", async () => { await rpc("set_emergency_stop", { p_on: true }); qc.invalidateQueries(); toast("Публикации остановлены"); })}><OctagonX className="h-4 w-4" />Остановить все публикации</Button>}</div>
        </Card>

        <Card title={<span className="flex items-center gap-2"><KeyRound className="h-4 w-4" />Claude (Anthropic API)</span>}>
          {ai.isLoading ? <Spinner /> : ai.error ? <p className="text-sm text-rose-600">{errText(ai.error)}</p> : (
            <>
              <p className="text-sm">Ключ: {ai.data!.anthropic.configured ? <Badge tone="green">задан {ai.data!.anthropic.hint}</Badge> : <Badge tone="amber">не задан</Badge>}</p>
              <p className="mt-1 text-xs text-slate-500">Ключ хранится в Supabase Vault и в браузер не возвращается. Получить: console.anthropic.com → API Keys.</p>
              <div className="mt-3 flex gap-2"><Input type="password" autoComplete="off" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
                <Button variant="primary" disabled={!key} loading={busy === "key"} onClick={() => wrap("key", async () => { await fn("app-settings", { action: "set_anthropic_key", key: key.trim() }); setKey(""); ai.refetch(); toast("Ключ сохранён и проверен"); })}>Сохранить</Button></div>
              {ai.data!.anthropic.configured && <Button variant="ghost" className="mt-2 text-rose-600" onClick={() => confirm("Удалить ключ Claude?") && wrap("clear", async () => { await fn("app-settings", { action: "clear_anthropic_key" }); ai.refetch(); toast("Ключ удалён"); })}>Удалить ключ</Button>}
              {!ai.data!.pricing_configured && <p className="mt-2 text-xs text-amber-600">Таблица цен (AI_PRICING_JSON) не задана — стоимость показывается как «Нет данных», бюджет не ограничивает расход.</p>}
            </>)}
        </Card>

        <Card title="Бюджет и модель">
          <div className="grid gap-3 sm:grid-cols-2">
            <Label label="Месячный бюджет Claude, $" hint="Проверяется до каждого запроса"><Input type="number" min={0} max={10000} step="1" value={budget} onChange={(e) => setBudget(e.target.value)} /></Label>
            <Label label="Модель" hint={`По умолчанию: ${ai.data?.model_default ?? "—"}`}><Input placeholder={ai.data?.model_default} value={model} onChange={(e) => setModel(e.target.value)} /></Label>
          </div>
          <Button className="mt-3" variant="primary" loading={busy === "budget"} onClick={() => wrap("budget", async () => { must(await supabase.from("system_settings").update({ ai_monthly_budget_usd: Number(budget) || 0, ai_model: model.trim() || null }).eq("owner_id", s.owner_id)); qc.invalidateQueries({ queryKey: ["settings"] }); toast("Сохранено"); })}>Сохранить</Button>
        </Card>

        <Card title="О системе">
          <ul className="space-y-1 text-sm text-slate-600 dark:text-slate-300">
            <li>Публикации выполняет фоновый worker (pg_cron, раз в минуту) — браузер можно закрыть.</li>
            <li>Токены площадок зашифрованы AES-256-GCM и не покидают сервер.</li>
            <li>Telegram — рабочая публикация. Instagram, YouTube, Threads — в следующей версии.</li>
            <li>Приложение персональное: после первой регистрации новые регистрации закрыты.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
