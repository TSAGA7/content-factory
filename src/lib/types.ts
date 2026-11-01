import type { Platform, PostFormat, PostStatus } from "@domain";

export interface Brand {
  id: string; name: string; description: string | null; niche: string | null; audience: string | null; positioning: string | null;
  tone: string | null; style: string | null; visual_concept: string | null; rubrics: string[]; forbidden_topics: string[];
  forbidden_phrases: string[]; required_elements: string[]; goals: string | null; posting_frequency: string | null;
  preferred_slots: string[]; hashtag_rules: string | null; cta_rules: string | null; examples: string | null; links: string[];
  color: string; is_active: boolean; created_at: string;
}

export interface Account {
  id: string; brand_id: string | null; platform: Platform; external_id: string | null; name: string; handle: string | null; url: string | null;
  connection_status: string; capabilities: Record<string, unknown>; scopes: string[]; timezone: string; is_paused: boolean;
  consecutive_failures: number; last_error: string | null; last_error_at: string | null; last_checked_at: string | null; last_published_at: string | null;
}

export interface Post {
  id: string; brand_id: string | null; account_id: string | null; parent_post_id: string | null; idea_id: string | null;
  format: PostFormat; title: string | null; body: string; hashtags: string[]; rubric: string | null; tags: string[];
  platform_options: Record<string, unknown>; status: PostStatus; scheduled_at: string | null; timezone: string;
  approved_by: "user" | "autopilot" | null; approved_at: string | null; quality_score: number | null; quality_passed: boolean | null;
  quality_report: QualityReport | null; external_id: string | null; external_url: string | null; published_at: string | null;
  last_error: string | null; version: number; created_at: string; updated_at: string;
}

export interface QualityReport { score: number; passed: boolean; problems: string[]; unverified_claims: string[]; brand_fit: string; suggestions: string[]; programmatic: string[]; checked_version: number }

export interface Media {
  id: string; brand_id: string | null; storage_path: string; file_name: string; kind: "image" | "video"; mime_type: string; size_bytes: number;
  width: number | null; height: number | null; duration_sec: number | null; sha256: string | null; tags: string[]; status: string; created_at: string;
}

export interface Idea {
  id: string; brand_id: string | null; account_id: string | null; title: string; angle: string | null; rubric: string | null;
  format: PostFormat | null; planned_at: string | null; source: string; status: string; post_id: string | null; created_at: string;
}

export interface Job {
  id: string; post_id: string; account_id: string; platform: Platform; status: string; phase: string; run_at: string; attempts: number;
  max_attempts: number; last_error: string | null; last_error_category: string | null; created_at: string; updated_at: string; finished_at: string | null;
}

export interface Stats {
  accounts_total: number; accounts_connected: number; accounts_problem: number; brands_active: number; posts_today: number; posts_7d: number;
  drafts: number; review_required: number; jobs_queued: number; jobs_blocked: number; jobs_overdue: number; published_total: number;
  published_30d: number; failed: number; ai_runs_month: number; ai_cost_month: number | null; ai_unpriced_month: number;
  worker_last_tick: string | null; emergency_stop: boolean;
}
