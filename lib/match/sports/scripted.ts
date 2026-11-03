// Shared pieces for the scripted sports (F1, basketball, hockey). Their scripts mark big moments themselves: an item
// may carry `signal` (a moment card: trigger, priority, label and a fact built from the state after it), `thread`
// (the #thread it opens) and `crowd` (the simulated fans' cue). The cricket fixture detects its moments with rules
// instead (lib/match/momentum.js).

export function scriptedSignals(next, item, seq) {
  if (!item.signal) return [];
  const { trigger, priority, label, fact } = item.signal;
  return [{
    trigger, priority, label,
    evidence: { clock: item.clock, text: item.text },
    fact_text: typeof fact === 'function' ? fact(next) : fact || item.text,
    dedupe: String(seq),
  }];
}

export const scriptedThread = (item) => item.thread || null;

// The script's cue for an item, or a background line now and then between the big moments.
export function scriptedBurst(item, rand, ambient = 0.5) {
  if (item.crowd) return item.crowd;
  return rand() < ambient ? { key: 'chatter', n: 1, spread: 2500 } : null;
}

export const ROLE = (name, team, role) => ({ name, team, role });
