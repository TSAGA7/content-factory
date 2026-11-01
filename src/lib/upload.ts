import { must, supabase } from "./supabase";
import type { Media } from "./types";

const ALLOWED = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm"];
export const MAX_UPLOAD = 50 * 1024 * 1024; // Supabase Free: 50 MB per file

async function probe(file: File): Promise<{ width?: number; height?: number; duration?: number }> {
  const url = URL.createObjectURL(file);
  try {
    if (file.type.startsWith("image/")) {
      const img = new Image();
      await new Promise((ok, err) => { img.onload = ok; img.onerror = err; img.src = url; });
      return { width: img.naturalWidth, height: img.naturalHeight };
    }
    const v = document.createElement("video");
    v.preload = "metadata";
    await new Promise((ok, err) => { v.onloadedmetadata = ok; v.onerror = err; v.src = url; });
    return { width: v.videoWidth, height: v.videoHeight, duration: Math.round(v.duration * 10) / 10 };
  } catch { return {}; } finally { URL.revokeObjectURL(url); }
}

async function sha256(file: File): Promise<string | null> {
  if (file.size > 200 * 1024 * 1024) return null;
  const h = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function uploadMedia(file: File, brandId?: string | null): Promise<Media> {
  if (!ALLOWED.includes(file.type)) throw new Error(`${file.name}: формат ${file.type || "?"} не поддерживается (JPEG, PNG, WebP, MP4, MOV, WebM)`);
  if (file.size > MAX_UPLOAD) throw new Error(`${file.name}: больше 50 МБ — лимит хранилища на бесплатном тарифе`);
  const { data: u } = await supabase.auth.getUser();
  const ext = (file.name.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${u.user!.id}/${crypto.randomUUID()}.${ext}`;
  const [meta, hash] = await Promise.all([probe(file), sha256(file)]);
  const up = await supabase.storage.from("media").upload(path, file, { contentType: file.type, upsert: false });
  if (up.error) throw new Error(`${file.name}: ${up.error.message}`);
  try {
    return must(await supabase.from("media_assets").insert({
      storage_path: path, file_name: file.name, kind: file.type.startsWith("image/") ? "image" : "video", mime_type: file.type, size_bytes: file.size,
      width: meta.width ?? null, height: meta.height ?? null, duration_sec: meta.duration ?? null, sha256: hash, brand_id: brandId ?? null,
    }).select().single()) as Media;
  } catch (e) {
    await supabase.storage.from("media").remove([path]);
    throw e;
  }
}
