// The simulated crowd's personas: CROWD_SIZE per sport, labelled "Simulated fan" wherever they appear. A seeded
// generator builds their handles, so every server instance agrees on them.
export const CROWD_SIZE = 200;

export interface Fan { handle: string; team: string }

// FNV-1a over the seed, then mulberry32: the same sequence everywhere.
export function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['aarav', 'vivaan', 'aditya', 'vihaan', 'arjun', 'sai', 'reyansh', 'krish', 'ishaan', 'shaurya', 'atharv', 'kabir',
  'rohan', 'dhruv', 'aryan', 'ayaan', 'yash', 'kunal', 'rahul', 'nikhil', 'varun', 'sid', 'manav', 'harsh', 'dev', 'parth',
  'tanmay', 'neel', 'kartik', 'aditi', 'ananya', 'diya', 'isha', 'kavya', 'meera', 'myra', 'navya', 'priya', 'riya', 'saanvi',
  'sara', 'tara', 'zoya', 'neha', 'pooja', 'sneha', 'divya', 'anu', 'tanvi', 'sana', 'ira', 'nisha', 'ruhi', 'jiya', 'mahi',
  'avni', 'khushi', 'farhan', 'imran', 'joel', 'sameer', 'aman', 'raj', 'vikram', 'gauri', 'mira', 'tina', 'arnav', 'samar'];

// `keep`: hand-written personas that come first. The rest alternate between the two fan sides.
export function makeFans(sides: string[], words: string[], { keep = [], count = CROWD_SIZE, seed = 'fans' }: { keep?: Fan[]; count?: number; seed?: string } = {}): Fan[] {
  const rand = seeded(seed);
  const pick = (xs: string[]) => xs[Math.floor(rand() * xs.length)];
  const fans = keep.map(({ handle, team }) => ({ handle, team }));
  const used = new Set(fans.map((f) => f.handle));
  while (fans.length < count) {
    const name = pick(NAMES);
    const word = pick(words);
    const style = Math.floor(rand() * 4);
    const handle = style === 0 ? `${name}_${word}` : style === 1 ? `${name}.${word}` : style === 2 ? `${word}_${name}` : `${name}${10 + Math.floor(rand() * 90)}`;
    if (used.has(handle) || handle.length > 20) continue;
    used.add(handle);
    fans.push({ handle, team: sides[fans.length % 2] });
  }
  return fans;
}
