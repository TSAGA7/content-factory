import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarX, Plus } from "lucide-react";
import { FORMAT_LABELS, POST_STATUS_LABELS } from "@domain";
import { PageHeader } from "@/components/AppShell";
import { Button, Empty, errText, Input, PlatformIcon, Select, Spinner, StatusBadge, useToast } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { useAccounts, useBrands } from "@/lib/queries";
import { must, rpc, supabase } from "@/lib/supabase";
import type { Post } from "@/lib/types";

export function PostsPage() {
  const [f, setF] = useState({ q: "", status: "", account: "", brand: "" });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const accounts = useAccounts().data ?? [];
  const brands = useBrands().data ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["posts", "all", f],
    queryFn: async () => {
      let q = supabase.from("content_posts").select("*").order("updated_at", { ascending: false }).limit(300);
      if (f.status) q = q.eq("status", f.status);
      if (f.account) q = q.eq("account_id", f.account);
      if (f.brand) q = q.eq("brand_id", f.brand);
      if (f.q) q = q.or(`title.ilike.%${f.q.replace(/[%,()]/g, "")}%,body.ilike.%${f.q.replace(/[%,()]/g, "")}%`);
      return must(await q) as Post[];
    },
  });

  async function bulkUnschedule() {
    if (!confirm(`Снять с расписания ${sel.size} материалов? Уже отправленные на площадку не отменяются.`)) return;
    let ok = 0; const errs: string[] = [];
    for (const id of sel) { try { await rpc("cancel_post_job", { p_post: id }); ok++; } catch (e) { errs.push(errText(e)); } }
    toast(`Снято: ${ok}${errs.length ? `, ошибок: ${errs.length} (${errs[0]})` : ""}`, errs.length ? "err" : "ok");
    setSel(new Set()); qc.invalidateQueries({ queryKey: ["posts"] }); qc.invalidateQueries({ queryKey: ["stats"] });
  }

  const acc = (id: string | null) => accounts.find((a) => a.id === id);
  return (
    <>
      <PageHeader title="Материалы" actions={<>
        {sel.size > 0 && <Button onClick={bulkUnschedule}><CalendarX className="h-4 w-4" />Снять с расписания ({sel.size})</Button>}
        <Link to="/posts/new"><Button variant="primary"><Plus className="h-4 w-4" />Новый</Button></Link>
      </>} />
      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Input placeholder="Поиск по тексту" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} className="col-span-2 md:col-span-1" />
        <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Все статусы</option>{Object.entries(POST_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        <Select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}><option value="">Все аккаунты</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
        <Select value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })}><option value="">Все бренды</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
      </div>
      {isLoading ? <Spinner /> : !data?.length ? <Empty title="Материалов нет" action={<Link to="/posts/new"><Button variant="primary">Создать</Button></Link>} /> : (
        <div className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200 dark:divide-slate-800 dark:bg-slate-900 dark:ring-slate-800">
          {data.map((p) => { const a = acc(p.account_id); return (
            <div key={p.id} className="flex items-center gap-3 p-3">
              <input type="checkbox" aria-label="Выбрать" checked={sel.has(p.id)} disabled={!["scheduled", "awaiting_credentials"].includes(p.status)}
                onChange={() => { const s = new Set(sel); s.has(p.id) ? s.delete(p.id) : s.add(p.id); setSel(s); }} />
              {a ? <PlatformIcon platform={a.platform} /> : <span className="h-6 w-6 rounded-md bg-slate-200 dark:bg-slate-700" />}
              <Link to={`/posts/${p.id}`} className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{p.title || p.body.slice(0, 100) || "Без текста"}</div>
                <div className="text-xs text-slate-500">{FORMAT_LABELS[p.format]} · {a?.name ?? "без аккаунта"} · {p.scheduled_at ? fmtDateTime(p.scheduled_at) : `изменён ${fmtDateTime(p.updated_at)}`}{p.quality_score != null ? ` · качество ${p.quality_score}` : ""}</div>
                {p.last_error && <div className="truncate text-xs text-rose-600">{p.last_error}</div>}
              </Link>
              <StatusBadge status={p.status} />
            </div>); })}
        </div>)}
    </>
  );
}
