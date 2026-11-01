import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Upload } from "lucide-react";
import { fmtBytes } from "@/lib/format";
import { signedUrl, useMedia } from "@/lib/queries";
import { uploadMedia } from "@/lib/upload";
import type { Media } from "@/lib/types";
import { Button, cx, errText, Modal, Spinner, useToast } from "./ui";

export function MediaTile({ m, selected, onClick }: { m: Media; selected?: boolean; onClick?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) { signedUrl(m.storage_path).then(setUrl); io.disconnect(); } });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, [m.storage_path]);
  return (
    <button ref={ref} type="button" onClick={onClick} className={cx("group relative aspect-square overflow-hidden rounded-lg bg-slate-200 text-left ring-2 dark:bg-slate-800", selected ? "ring-indigo-500" : "ring-transparent")}>
      {url && (m.kind === "image" ? <img src={url} alt={m.file_name} className="h-full w-full object-cover" loading="lazy" /> : <video src={url} className="h-full w-full object-cover" muted preload="metadata" />)}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 p-1.5 text-[10px] text-white">
        <div className="truncate">{m.file_name}</div><div>{m.kind === "video" ? `видео${m.duration_sec ? ` ${m.duration_sec}с` : ""}` : "фото"} · {fmtBytes(m.size_bytes)}{m.width ? ` · ${m.width}×${m.height}` : ""}</div>
      </div>
      {m.status === "missing" && <span className="absolute left-1 top-1 rounded bg-rose-600 px-1 text-[10px] text-white">нет файла</span>}
      {selected && <span className="absolute right-1 top-1 rounded-full bg-indigo-600 p-0.5 text-white"><Check className="h-3 w-3" /></span>}
    </button>
  );
}

export function MediaPicker({ selected, onPick, onClose }: { selected: string[]; onPick: (m: Media[]) => void; onClose: () => void }) {
  const { data, isLoading } = useMedia();
  const [pick, setPick] = useState<Media[]>([]);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    const added: Media[] = [];
    for (const f of Array.from(files)) { try { added.push(await uploadMedia(f)); } catch (e) { toast(errText(e), "err"); } }
    setBusy(false);
    qc.invalidateQueries({ queryKey: ["media"] });
    setPick((p) => [...p, ...added]);
  }
  return (
    <Modal open onClose={onClose} title="Медиатека" wide>
      <label className="mb-3 flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 p-4 text-sm text-slate-500 hover:border-indigo-400 dark:border-slate-700">
        <Upload className="h-4 w-4" />{busy ? "Загрузка…" : "Загрузить файлы (JPEG, PNG, WebP, MP4, MOV, WebM до 50 МБ)"}
        <input type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" className="hidden" onChange={(e) => upload(e.target.files)} />
      </label>
      {isLoading ? <Spinner /> : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {(data ?? []).filter((m) => !selected.includes(m.id)).map((m) => <MediaTile key={m.id} m={m} selected={pick.some((p) => p.id === m.id)} onClick={() => setPick(pick.some((p) => p.id === m.id) ? pick.filter((p) => p.id !== m.id) : [...pick, m])} />)}
        </div>)}
      <div className="mt-4 flex justify-end gap-2"><Button onClick={onClose}>Отмена</Button><Button variant="primary" disabled={!pick.length} onClick={() => onPick(pick)}>Добавить ({pick.length})</Button></div>
    </Modal>
  );
}
