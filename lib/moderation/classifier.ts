// Fast pre-publication safety gate. Deterministic and explainable, so it can run on every message before
// broadcast without waiting for an AI provider. Risk-based: ordinary banter passes, the mandatory baseline
// is enforced at every level, uncertain high-risk text is held for human review rather than published.
import { MANDATORY, PRIVACY, UNCERTAIN, PROFANITY_STRONG, PROFANITY_MILD, INSULT, TARGETED, LINK } from './lexicon.ts';
import { POLICY_VERSION } from './policy.ts';

const LEET: Record<string, string> = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i' };

type Action = 'allow' | 'flag' | 'hold' | 'reject';
type Risk = 'low' | 'medium' | 'high';
interface Verdict<A extends Action, R extends string | null> { action: A; risk: Risk; categories: string[]; level: string; reason: R; policy_version: string }
// What the gate decided: allow, flag (published and logged), hold (for human review) or reject (never stored).
// A reject or hold always carries the reason the sender sees; allow and flag carry none.
export type Decision = Verdict<'reject' | 'hold', string> | Verdict<'allow' | 'flag', null>;

export function normalise(text: string): string {
  let t = text.normalize('NFKC').toLowerCase().replace(/[’'`]/g, '');
  // Leetspeak only between letters, so scores ("148/3") and @mentions survive.
  t = t.replace(/(?<=[a-z])[013457@$!8](?=[a-z])/g, (c) => LEET[c] || c);
  // Stretched letters: "fuuuuck" -> "fuck", "noooo" -> "no".
  t = t.replace(/([a-z])\1{2,}/g, '$1');
  return t;
}

// The same text with separators inside words removed ("ch.u.t.i.y.a" -> "chutiya"), checked alongside the
// normalised text. Links are matched on the normalised text only, where their dots are intact.
const squash = (t: string) => t.replace(/(?<=[a-z])[.*_-]+(?=[a-z])/g, '').replace(/([a-z])\1{2,}/g, '$1');

const hit = (patterns: RegExp[], text: string) => patterns.some((re) => re.test(text));

// By rule name; the mandatory rules are keyed by their MANDATORY category.
const REASONS: Record<string, string> = {
  threat: 'Threats are not allowed in Huddle, even as a joke.',
  self_harm: 'Telling someone to hurt themselves is not allowed.',
  hate: 'Hate speech and slurs are not allowed.',
  sexual: 'Sexual harassment is not allowed.',
  privacy: 'Do not share phone numbers, emails or other personal details in the room.',
  uncertain: 'This message needs a quick human review before it can be shown.',
  personal_attack: 'Keep it about the cricket, not the person.',
  profanity: 'This room filters strong language. Try rephrasing.',
  insult: 'This room filters insults. Try rephrasing.',
  disruptive: 'This room filters links and spammy messages.',
};

function decision(action: 'reject' | 'hold', risk: Risk, categories: string[], level: string, reasonKey: string): Decision;
function decision(action: 'allow' | 'flag', risk: Risk, categories: string[], level: string, reasonKey: null): Decision;
function decision(action: Action, risk: Risk, categories: string[], level: string, reasonKey: string | null): Verdict<Action, string | null> {
  return { action, risk, categories, level, reason: reasonKey ? REASONS[reasonKey] : null, policy_version: POLICY_VERSION };
}

function disruptive(original: string) {
  const letters = original.replace(/[^A-Za-z]/g, '');
  const shouting = letters.length >= 25 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.9;
  return shouting || /(.)\1{9,}/u.test(original) || /\b(\w+)\b(?:\W+\1\b){4,}/i.test(original);
}

// level: relaxed | balanced | strict (resolved server-side by policy.effectivePolicy). Any other string gets the
// relaxed rules.
export function classify(original: string, { level = 'balanced' }: { level?: string } = {}): Decision {
  const base = normalise(original);
  const squashed = squash(base);
  const text = squashed === base ? base : `${base}\n${squashed}`;

  // 1. Mandatory baseline: the same at every level and in every room type.
  for (const [category, patterns] of Object.entries(MANDATORY)) {
    if (hit(patterns, text)) return decision('reject', 'high', [category], level, category);
  }
  if (hit(PRIVACY, original)) return decision('reject', 'high', ['privacy'], level, 'privacy');
  if (hit(UNCERTAIN, text)) return decision('hold', 'high', ['possible_threat'], level, 'uncertain');

  // 2. Level-dependent conversational strictness.
  const strong = PROFANITY_STRONG.test(text);
  const mild = PROFANITY_MILD.test(text);
  const insult = INSULT.test(text);
  const targeted = TARGETED.test(text);
  const link = LINK.test(base);
  const categories = [strong && 'profanity_strong', mild && 'profanity_mild', insult && 'insult', targeted && (strong || mild || insult) && 'targeted', link && 'link'].filter((c) => c !== false);

  if (level === 'strict') {
    if ((strong || mild || insult) && targeted) return decision('reject', 'medium', categories, level, 'personal_attack');
    if (strong || mild) return decision('reject', 'medium', categories, level, 'profanity');
    if (insult) return decision('reject', 'medium', categories, level, 'insult');
    if (link || disruptive(original)) return decision('reject', 'low', [...categories, 'disruptive'], level, 'disruptive');
    return decision('allow', 'low', [], level, null);
  }
  if (level === 'balanced') {
    if ((strong || mild || insult) && targeted) return decision('reject', 'medium', categories, level, 'personal_attack');
    if (strong || link) return decision('flag', 'low', categories, level, null);
    return decision('allow', 'low', categories, level, null);
  }
  // relaxed
  if ((strong || insult) && targeted) {
    // Strong abuse aimed at someone is still stopped; a mild jab at a friend is only flagged.
    if (strong || /\b(?:retard\w*|kutta|kutte|kuttiya|suar)\b/.test(text)) return decision('reject', 'medium', categories, level, 'personal_attack');
    return decision('flag', 'low', categories, level, null);
  }
  if (strong) return decision('flag', 'low', categories, level, null);
  return decision('allow', 'low', categories, level, null);
}

// Names (handles, display names, room names) are public labels: strict, plus no mentions or links.
export function checkName(value: string): boolean {
  const d = classify(value, { level: 'strict' });
  return d.action === 'allow' && !/@/.test(value);
}
