// Row shapes of the tables several modules pass around (lib/db/migrations is the source of truth); a table only one
// module reads keeps its row type in that module. Timestamps arrive as Date objects, jsonb as parsed JSON.

export type Sports = Record<string, { team: string | null; picks: string[] }>;

export interface UserRow {
  id: string;
  handle: string | null;
  sports: Sports;
  created_at: Date;
  last_login_at: Date | null;
}

export type RoomType = 'public' | 'private';
export type ModerationLevel = 'relaxed' | 'balanced' | 'strict';
export type RoomRole = 'owner' | 'admin' | 'member';

export interface RoomRow {
  id: string;
  name: string | null;
  room_type: RoomType;
  creator_id: string | null;
  match_id: string | null;
  moderation_level: ModerationLevel | null;
  status: 'active' | 'ended' | 'purged';
  last_seq: number;
  ai_enabled: boolean;
  created_at: Date;
  updated_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
  purge_after: Date | null;
}

export interface MatchRow {
  id: string;
  fixture_key: string;
  title: string;
  team_a: string;
  team_b: string;
  format: string;
  source: string;
  status: 'scheduled' | 'live' | 'completed';
  feed_started_at: Date | null;
  ball_interval_ms: number;
  backfill_until: number; // no longer written: only the removed jump to a moment set it
  created_at: Date;
  completed_at: Date | null;
}

export interface MatchEventRow {
  id: string;
  match_id: string;
  provider_event_id: string;
  seq: number;
  kind: string;
  data: any; // the fixture item as published (each sport's own shape)
  occurred_at: Date;
  ingested_at: Date;
  backfilled: boolean; // true only on rows a removed jump to a moment skipped over
}

export type Priority = 'high' | 'medium' | 'low';

export interface SignalRow {
  id: string;
  match_id: string;
  event_id: string;
  trigger: string;
  priority: Priority;
  label: string;
  evidence: any;
  fact_text: string;
  dedupe_key: string;
  status: 'pending' | 'published' | 'suppressed' | 'expired';
  status_reason: string | null;
  ai_text: string | null;
  ai_provider: string | null;
  ai_model: string | null;
  created_at: Date;
  expires_at: Date;
  published_at: Date | null;
}

export type AnswerState = 'pending' | 'human' | 'ai_claimed' | 'ai_answered' | 'ai_unavailable' | 'cancelled';

export interface MessageRow {
  id: string;
  room_id: string;
  seq: number | null;
  sender_type: 'user' | 'ai';
  sender_id: string | null;
  client_msg_id: string | null;
  body: string | null;
  reply_to_id: string | null;
  status: 'visible' | 'held' | 'removed';
  is_question: boolean;
  answer_state: AnswerState | null;
  ai_meta: any;
  moderation: any;
  created_at: Date;
  thread_id: string | null;
  match_seq: number | null;
}

export interface PollRow {
  id: string;
  room_id: string;
  seq: number;
  question: string;
  options: { label: string }[];
  source: string;
  requested_by: string | null;
  idempotency_key: string;
  status: 'open' | 'closed';
  closes_at: Date;
  created_at: Date;
}

export interface ThreadRow {
  id: string;
  room_id: string;
  slug: string;
  title: string;
  about: string | null;
  keywords: string[];
  source: 'moment' | 'discussion';
  created_at: Date;
  last_active_at: Date;
}

export interface RoomEventRow {
  room_id: string;
  seq: number;
  type: string;
  entity_id: string | null;
  created_at: Date;
}

export interface JobRow {
  id: string;
  type: string;
  room_id: string | null;
  dedupe_key: string | null;
  payload: any;
  priority: number;
  status: 'queued' | 'running' | 'done' | 'dead' | 'cancelled';
  run_at: Date;
  expires_at: Date | null;
  attempts: number;
  max_attempts: number;
  locked_until: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}
