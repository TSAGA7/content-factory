import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/AppShell";
import { Button, cx, Empty, Select, Spinner } from "@/components/ui";
import { fmtDateTime, fmtUsd } from "@/lib/format";
import { useNotifications } from "@/lib/queries";
import { must, supabase } from "@/lib/supabase";

export function JournalPage() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") ?? "events";
  return (
    <>
      <PageHeader title="Журнал" />
      <div className="mb-4 flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800 sm:inline-flex">
        {[["events", "События"], ["notifications", "Уведомления"], ["ai", "Запросы Claude"]].map(([k, l]) => <button key={k} onClick={() => setSp({ tab: k! })} className={cx("flex-1 rounded-md px-3 py-1 text-sm", tab === k && "bg-white shadow dark:bg-slate-700")}>{l}</button>)}
      </div>
      {tab === "events" ? <Events /> : tab === "notifications" ? <Notifications /> : <AiRuns />}
    </>
  );
}

function Events() {
  const [level, setLevel] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["audit", level], queryFn: async () => { let q = supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(300); if (level) q = q.eq("level", level); return must(await q) as { id: number; level: string; event: string; entity_type: string | null; entity_id: string | null; message: string; created_at: string }[]; } });
  return (
    <>
      <Select className="mb-3 max-w-xs" value={level} onChange={(e) => setLevel(e.target.value)}><option value="">Все уровни</option><option value="error">Ошибки</option><option value="warn">Предупреждения</option><option value="info">Информация</option></Select>
      {isLoading ? <Spinner /> : !data?.length ? <Empty title="Событий нет" /> : (
        <ul className="divide-y divide-slate-100 rounded-xl bg-white text-sm ring-1 ring-slate-200 dark:divide-slate-800 dark:bg-slate-900 dark:ring-slate-800">
          {data.map((e) => (
            <li key={e.id} className="flex gap-3 p-3">
              <span className={e.level === "error" ? "text-rose-600" : e.level === "warn" ? "text-amber-600" : "text-slate-400"}>●</span>
              <div className="min-w-0 flex-1">{e.entity_type === "content_post" && e.entity_id ? <Link to={`/posts/${e.entity_id}`} className="hover:text-indigo-600">{e.message}</Link> : e.message}<div className="text-xs text-slate-500">{e.event}</div></div>
              <span className="shrink-0 text-xs text-slate-500">{fmtDateTime(e.created_at)}</span>
            </li>))}
        </ul>)}
    </>
  );
}

function Notifications() {
  const { data, isLoading } = useNotifications();
  const qc = useQueryClient();
  async function readAll() { await supabase.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null); qc.invalidateQueries({ queryKey: ["notifications"] }); }
  return (
    <>
      <Button className="mb-3" onClick={readAll}>Отметить все прочитанными</Button>
      {isLoading ? <Spinner /> : !data?.length ? <Empty title="Уведомлений нет" /> : (
        <ul className="space-y-2">{data.map((n) => (
          <li key={n.id} className={cx("rounded-xl bg-white p-3 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800", !n.read_at && "border-l-4 border-indigo-500")}>
            <div className="flex justify-between gap-2"><span className={cx("font-medium", n.level === "error" && "text-rose-600", n.level === "warn" && "text-amber-600")}>{n.title}</span><span className="text-xs text-slate-500">{fmtDateTime(n.created_at)}</span></div>
            {n.body && <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{n.body}</p>}
            {n.link && <Link to={n.link} className="mt-1 inline-block text-sm text-indigo-600">Открыть →</Link>}
          </li>))}</ul>)}
    </>
  );
}

function AiRuns() {
  const { data, isLoading } = useQuery({ queryKey: ["ai_runs"], queryFn: async () => must(await supabase.from("ai_runs").select("*").order("created_at", { ascending: false }).limit(200)) as { id: string; task: string; model: string; status: string; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null; duration_ms: number | null; error: string | null; prompt_version: string; created_at: string }[] });
  return isLoading ? <Spinner /> : !data?.length ? <Empty title="Запросов к Claude пока не было" /> : (
    <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-slate-500"><tr>{["Время", "Задача", "Статус", "Токены вх/вых", "Стоимость", "Длительность"].map((h) => <th key={h} className="p-2 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{data.map((r) => (
          <tr key={r.id}><td className="whitespace-nowrap p-2">{fmtDateTime(r.created_at)}</td><td className="p-2">{r.task}<div className="text-xs text-slate-500">{r.model} · {r.prompt_version}</div></td>
            <td className="p-2">{r.status === "ok" ? "OK" : <span className="text-rose-600" title={r.error ?? ""}>{r.status}</span>}</td><td className="p-2">{r.input_tokens ?? "—"} / {r.output_tokens ?? "—"}</td><td className="p-2">{fmtUsd(r.cost_usd)}</td><td className="p-2">{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)} с` : "—"}</td></tr>))}</tbody>
      </table>
    </div>
  );
}
