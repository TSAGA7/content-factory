import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2, Upload } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { MediaTile } from "@/components/MediaPicker";
import { Badge, Button, Empty, errText, Input, Modal, Select, Spinner, useToast } from "@/components/ui";
import { fmtBytes, fmtDateTime } from "@/lib/format";
import { useBrands, useMedia } from "@/lib/queries";
import { must, supabase } from "@/lib/supabase";
import { uploadMedia } from "@/lib/upload";
import type { Media } from "@/lib/types";

export function MediaPage() {
  const { data, isLoading } = useMedia();
  const brands = useBrands().data ?? [];
  const [f, setF] = useState({ q: "", kind: "", brand: "" });
  const [busy, setBusy] = useState(0);
  const [open, setOpen] = useState<Media | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(files.length);
    let ok = 0;
    for (const file of Array.from(files)) { try { await uploadMedia(file, f.brand || null); ok++; } catch (e) { toast(errText(e), "err"); } setBusy((b) => b - 1); }
    if (ok) toast(`Загружено: ${ok}`);
    qc.invalidateQueries({ queryKey: ["media"] });
  }

  const list = (data ?? []).filter((m) => (!f.kind || m.kind === f.kind) && (!f.brand || m.brand_id === f.brand) && (!f.q || m.file_name.toLowerCase().includes(f.q.toLowerCase()) || m.tags.some((t) => t.toLowerCase().includes(f.q.toLowerCase()))));
  return (
    <>
      <PageHeader title="Медиатека" sub="Приватное хранилище; для публикации worker выдаёт временные ссылки" actions={
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500">
          <Upload className="h-4 w-4" />{busy ? `Загрузка… (${busy})` : "Загрузить"}
          <input type="file" multiple className="hidden" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" onChange={(e) => upload(e.target.files)} />
        </label>} />
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Input placeholder="Поиск по имени или тегу" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="">Фото и видео</option><option value="image">Фото</option><option value="video">Видео</option></Select>
        <Select value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })}><option value="">Все бренды</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
      </div>
      {isLoading ? <Spinner /> : !list.length ? <Empty title="Файлов нет" text="До 50 МБ на файл на бесплатном тарифе Supabase." /> : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">{list.map((m) => <MediaTile key={m.id} m={m} onClick={() => setOpen(m)} />)}</div>)}
      {open && <MediaDetails m={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function MediaDetails({ m, onClose }: { m: Media; onClose: () => void }) {
  const brands = useBrands().data ?? [];
  const [tags, setTags] = useState(m.tags.join(", "));
  const [brand, setBrand] = useState(m.brand_id ?? "");
  const qc = useQueryClient();
  const toast = useToast();
  async function save() {
    try { must(await supabase.from("media_assets").update({ tags: tags.split(",").map((t) => t.trim()).filter(Boolean), brand_id: brand || null }).eq("id", m.id)); qc.invalidateQueries({ queryKey: ["media"] }); toast("Сохранено"); onClose(); }
    catch (e) { toast(errText(e), "err"); }
  }
  async function remove() {
    const { count } = await supabase.from("post_media").select("post_id", { count: "exact", head: true }).eq("media_id", m.id);
    if (count) { toast(`Файл используется в ${count} материалах — сначала уберите его оттуда`, "err"); return; }
    if (!confirm(`Удалить «${m.file_name}» безвозвратно?`)) return;
    try { must(await supabase.from("media_assets").delete().eq("id", m.id)); await supabase.storage.from("media").remove([m.storage_path]); qc.invalidateQueries({ queryKey: ["media"] }); toast("Удалено"); onClose(); }
    catch (e) { toast(errText(e), "err"); }
  }
  return (
    <Modal open onClose={onClose} title={m.file_name}>
      <div className="w-40"><MediaTile m={m} /></div>
      <dl className="mt-3 grid grid-cols-2 gap-1 text-sm">
        <dt className="text-slate-500">Тип</dt><dd>{m.mime_type}</dd><dt className="text-slate-500">Размер</dt><dd>{fmtBytes(m.size_bytes)}</dd>
        {m.width && <><dt className="text-slate-500">Разрешение</dt><dd>{m.width}×{m.height}</dd></>}
        {m.duration_sec && <><dt className="text-slate-500">Длительность</dt><dd>{m.duration_sec} с</dd></>}
        <dt className="text-slate-500">Загружен</dt><dd>{fmtDateTime(m.created_at)}</dd>
        <dt className="text-slate-500">Статус</dt><dd>{m.status === "missing" ? <Badge tone="rose">Файл недоступен</Badge> : <Badge tone="green">Доступен</Badge>}</dd>
        {m.sha256 && <><dt className="text-slate-500">SHA-256</dt><dd className="truncate font-mono text-xs" title={m.sha256}>{m.sha256}</dd></>}
      </dl>
      <div className="mt-3 space-y-2">
        <Input placeholder="Теги через запятую" value={tags} onChange={(e) => setTags(e.target.value)} />
        <Select value={brand} onChange={(e) => setBrand(e.target.value)}><option value="">Без бренда</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
      </div>
      <div className="mt-4 flex justify-between"><Button variant="ghost" className="text-rose-600" onClick={remove}><Trash2 className="h-4 w-4" />Удалить</Button><Button variant="primary" onClick={save}>Сохранить</Button></div>
    </Modal>
  );
}
