// Shared pieces for the scripted sports (F1, basketball, hockey), whose scripts mark their own big moments, threads
// and crowd cues. Cricket detects its moments with rules instead (momentum.ts).
import type { Priority } from '../../db/rows.ts';
import type { CrowdCue, MomentThread, RosterEntry, Signal } from '../fixture.ts';

// A moment card marked in the script. `fact` is fixed text or built from the state after the item; the item's own
// text stands in when it has none.
interface ScriptSignal<State> {
  trigger: string;
  priority: Priority;
  label: string;
  fact?: string | ((state: State) => string);
}

// What every scripted sport's items carry; `type` and `label` are set on events only.
export interface ScriptedItem<State> {
  kind: 'play' | 'event';
  clock: string;
  text: string;
  type?: string;
  label?: string;
  signal?: ScriptSignal<State>;
  thread?: MomentThread;
  crowd?: CrowdCue;
  moment?: string;
  pause?: number;
}

export function scriptedSignals<State>(next: State, item: ScriptedItem<State>, seq: number): Signal[] {
  if (!item.signal) return [];
  const { trigger, priority, label, fact } = item.signal;
  return [{
    trigger, priority, label,
    evidence: { clock: item.clock, text: item.text },
    fact_text: typeof fact === 'function' ? fact(next) : fact || item.text,
    dedupe: String(seq),
  }];
}

export const scriptedThread = (item: { thread?: MomentThread }): MomentThread | null => item.thread || null;

// The script's cue for an item, or a background line now and then between the big moments.
export function scriptedBurst(item: { crowd?: CrowdCue }, rand: () => number, ambient = 0.5): CrowdCue | null {
  if (item.crowd) return item.crowd;
  return rand() < ambient ? { key: 'chatter', n: 1, spread: 2500 } : null;
}

export const ROLE = (name: string, team: string, role: string): RosterEntry => ({ name, team, role });
