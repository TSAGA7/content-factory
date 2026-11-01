import { useQuery } from "@tanstack/react-query";
import { must, rpc, supabase } from "./supabase";
import type { Account, Brand, Idea, Media, Post, Stats } from "./types";

export const useBrands = () => useQuery({ queryKey: ["brands"], queryFn: async () => must(await supabase.from("brands").select("*").order("name")) as Brand[] });
export const useAccounts = () => useQuery({ queryKey: ["accounts"], queryFn: async () => must(await supabase.from("social_accounts").select("*").order("name")) as Account[] });
export const useStats = () => useQuery({ queryKey: ["stats"], queryFn: () => rpc<Stats>("dashboard_stats"), refetchInterval: 30_000 });
export const useMedia = () => useQuery({ queryKey: ["media"], queryFn: async () => must(await supabase.from("media_assets").select("*").order("created_at", { ascending: false }).limit(500)) as Media[] });
export const useIdeas = () => useQuery({ queryKey: ["ideas"], queryFn: async () => must(await supabase.from("content_ideas").select("*").order("planned_at", { ascending: true, nullsFirst: false }).limit(500)) as Idea[] });

export const usePostsRange = (from: string, to: string) => useQuery({
  queryKey: ["posts", from, to],
  queryFn: async () => must(await supabase.from("content_posts").select("*")
    .or(`and(scheduled_at.gte.${from},scheduled_at.lt.${to}),and(published_at.gte.${from},published_at.lt.${to})`)
    .order("scheduled_at")) as Post[],
});

export const useUnscheduled = () => useQuery({
  queryKey: ["posts", "unscheduled"],
  queryFn: async () => must(await supabase.from("content_posts").select("*").is("scheduled_at", null).not("status", "in", "(published,cancelled)").order("updated_at", { ascending: false }).limit(200)) as Post[],
});

export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: async () => must(await supabase.from("system_settings").select("*").single()) as { owner_id: string; emergency_stop: boolean; ai_monthly_budget_usd: number; ai_model: string | null } });

export const useNotifications = () => useQuery({
  queryKey: ["notifications"], refetchInterval: 60_000,
  queryFn: async () => must(await supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(50)) as { id: string; level: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string }[],
});

export const signedUrl = async (path: string) => (await supabase.storage.from("media").createSignedUrl(path, 3600)).data?.signedUrl ?? null;
