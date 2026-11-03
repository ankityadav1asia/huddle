// Moderation policy. Public rooms get a platform policy from server configuration that no client can
// change; private rooms use the owner's chosen level. The mandatory baseline applies to both and to every level.
import { config } from '../config.ts';
import type { ModerationLevel, RoomType } from '../db/rows.ts';

export const LEVELS: ModerationLevel[] = ['relaxed', 'balanced', 'strict'];
export const POLICY_VERSION = '2026-11-02.1';
export const MANDATORY_SAFETY_RULES = ['threats', 'self_harm', 'hate', 'sexual_exploitation', 'privacy_doxxing'];

export const LEVEL_INFO: Record<ModerationLevel, string> = {
  relaxed: 'Friendly banter and mild casual language are fine. Personal attacks and abuse are still stopped.',
  balanced: 'Recommended. Heated cricket talk is fine; personal attacks, harassment and disruptive behaviour are flagged or stopped.',
  strict: 'Filters profanity, insults, links and spammy messages more tightly.',
};

// The policy in force in a room, resolved on the server.
export interface Policy { level: ModerationLevel; source: 'platform' | 'room'; policy_version: string; mandatory: string[] }

// A level read from configuration or the database counts only if it is one of LEVELS.
const KNOWN_LEVELS: readonly unknown[] = LEVELS;
const isLevel = (value: unknown): value is ModerationLevel => KNOWN_LEVELS.includes(value);

export function publicPolicy() {
  const configured = config().publicModerationLevel;
  const level: ModerationLevel = isLevel(configured) ? configured : 'balanced';
  return {
    policy_version: POLICY_VERSION,
    public_default_level: level,
    mandatory_safety_rules: MANDATORY_SAFETY_RULES,
    updated_at: '2026-11-02',
  };
}

// Resolves the effective policy from the room record loaded from the database, never from client input.
// The stored moderation_level is checked, not trusted.
export function effectivePolicy(room: { room_type: RoomType; moderation_level: string | null }): Policy {
  if (room.room_type === 'public') {
    const p = publicPolicy();
    return { level: p.public_default_level, source: 'platform', policy_version: p.policy_version, mandatory: p.mandatory_safety_rules };
  }
  const level = isLevel(room.moderation_level) ? room.moderation_level : 'balanced';
  return { level, source: 'room', policy_version: POLICY_VERSION, mandatory: MANDATORY_SAFETY_RULES };
}
