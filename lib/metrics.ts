// In-process operational samples for the prototype's ops endpoint (per server instance, last 500 values).
const series = new Map<string, number[]>();
const counters = new Map<string, number>();

export function observe(name: string, value: number) {
  if (!Number.isFinite(value)) return;
  const s = series.get(name) || [];
  s.push(value);
  if (s.length > 500) s.shift();
  series.set(name, s);
}

export function count(name: string, n = 1) {
  counters.set(name, (counters.get(name) || 0) + n);
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

interface SeriesSummary { samples: number; p50: number; p95: number; max: number | undefined }

export function metricsSnapshot() {
  const out: Record<string, SeriesSummary> = {};
  for (const [name, values] of series) {
    const sorted = [...values].sort((a, b) => a - b);
    out[name] = { samples: sorted.length, p50: pct(sorted, 50), p95: pct(sorted, 95), max: sorted.at(-1) };
  }
  return { series: out, counters: Object.fromEntries(counters) };
}
