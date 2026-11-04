// Everything before the feed starts: the toss, Mumbai's innings and the first 14 overs of the chase, ball by ball.
// Fixture data like the script (a made-up match with real players). Replaying these balls gives exactly the
// scorecard the feed starts from (START in demo-script.ts), so Dream AI's record of the whole match and the live
// scorecard always agree.

// One delivery. A wide shares the over.ball label of the next legal ball, as on the live scorecard.
export interface Delivery {
  over: number; // 1-based
  label: string;
  bowler: string;
  bat: string;
  runs: number; // off the bat, or the extra
  extra: 'wd' | 'lb' | null;
  wicket: { out: string; how: string } | null;
}

// overs: [bowler, balls] in order. Ball tokens: 0-6 off the bat, w a wide (1 run), l a leg-bye (1 run), W a wicket
// (the striker), whose description is the next in `outs`.
export interface InningsPlan {
  batting: string;
  bowling: string;
  order: string[];
  overs: [string, string][];
  outs: string[];
}

export function play(plan: InningsPlan): Delivery[] {
  const out: Delivery[] = [];
  let [striker, other] = plan.order;
  let next = 2;
  let legal = 0;
  let fallen = 0;
  plan.overs.forEach(([bowler, balls], i) => {
    for (const t of balls.split(' ')) {
      const label = `${Math.floor(legal / 6)}.${(legal % 6) + 1}`;
      if (t === 'w') {
        out.push({ over: i + 1, label, bowler, bat: striker, runs: 1, extra: 'wd', wicket: null });
        continue;
      }
      legal += 1;
      if (t === 'W') {
        out.push({ over: i + 1, label, bowler, bat: striker, runs: 0, extra: null, wicket: { out: striker, how: plan.outs[fallen++] } });
        striker = plan.order[next++];
        continue;
      }
      const runs = t === 'l' ? 1 : Number(t);
      out.push({ over: i + 1, label, bowler, bat: striker, runs, extra: t === 'l' ? 'lb' : null, wicket: null });
      if (runs % 2) [striker, other] = [other, striker];
    }
    [striker, other] = [other, striker];
  });
  return out;
}

export const VENUE = 'Wankhede Stadium, Mumbai';
export const TOSS = 'Chennai Super Kings won the toss and chose to bowl first.';

export const MI_INNINGS: InningsPlan = {
  batting: 'MI',
  bowling: 'CSK',
  order: ['Rohit Sharma', 'Ryan Rickelton', 'Suryakumar Yadav', 'Tilak Varma', 'Hardik Pandya', 'Naman Dhir', 'Mitchell Santner', 'Deepak Chahar'],
  overs: [
    ['Khaleel Ahmed', '4 0 1 4 3 0'],
    ['Anshul Kamboj', '4 0 1 4 0 2'],
    ['Khaleel Ahmed', '0 0 W 1 1 0'],
    ['Jamie Overton', '2 0 4 0 0 2'],
    ['Nathan Ellis', '1 0 1 0 4 0'],
    ['Anshul Kamboj', '6 4 0 W l 1'],
    ['Noor Ahmad', '4 0 0 1 1 1'],
    ['Nathan Ellis', '1 0 0 w 4 1 4'],
    ['Noor Ahmad', '1 0 4 0 1 0'],
    ['Jamie Overton', '1 6 1 6 1 2'],
    ['Nathan Ellis', '1 0 1 0 6 4'],
    ['Noor Ahmad', '1 1 W 0 6 0'],
    ['Anshul Kamboj', '1 0 0 l 1 4'],
    ['Noor Ahmad', '1 2 1 3 1 0'],
    ['Jamie Overton', '0 2 1 4 1 w 0'],
    ['Nathan Ellis', '0 0 1 6 W 0'],
    ['Khaleel Ahmed', '1 2 2 0 1 6'],
    ['Anshul Kamboj', '4 W 0 0 1 2'],
    ['Khaleel Ahmed', '6 1 6 W 1 1'],
    ['Jamie Overton', '0 1 4 1 0 w 2'],
  ],
  outs: ['c Dhoni b Khaleel', 'c Dube b Kamboj', 'st Dhoni b Noor', 'c Gaikwad b Ellis', 'run out (Brevis)', 'c Brevis b Khaleel'],
};
export const MI_DID_NOT_BAT = ['Trent Boult', 'Jasprit Bumrah'];

// The chase up to the strategic timeout after 14 overs, where the feed takes over.
export const CSK_TO_FEED: InningsPlan = {
  batting: 'CSK',
  bowling: 'MI',
  order: ['Sanju Samson', 'Ayush Mhatre', 'Shivam Dube', 'Ruturaj Gaikwad', 'Dewald Brevis', 'MS Dhoni'],
  overs: [
    ['Trent Boult', '0 w 6 0 0 1 1'],
    ['Deepak Chahar', '0 2 4 l 1 1'],
    ['Jasprit Bumrah', '0 0 4 2 W 2'],
    ['Deepak Chahar', '6 2 4 0 w 0 0'],
    ['Trent Boult', '1 0 1 1 4 4'],
    ['Jasprit Bumrah', '0 1 1 1 2 1'],
    ['Hardik Pandya', '0 0 4 2 1 2 w'],
    ['Mitchell Santner', '0 1 1 0 1 4'],
    ['Deepak Chahar', '0 0 2 W 2 0'],
    ['Mitchell Santner', '6 0 1 l 4 0'],
    ['Hardik Pandya', '2 1 1 1 6 0'],
    ['Trent Boult', '0 6 w 0 0 0 0'],
    ['Mitchell Santner', '0 0 2 1 4 l'],
    ['Deepak Chahar', '4 1 0 1 1 6'],
  ],
  outs: ['c Rickelton b Bumrah', 'c Naman Dhir b Chahar'],
};

