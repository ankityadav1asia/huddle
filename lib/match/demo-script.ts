// The scripted MI v CSK chase (CSK chasing 187): fixture data, a made-up match with real players. The moderation
// tests use its crowd lines as a corpus of ordinary cricket banter.
import type { CrowdCue } from './fixture.ts';

export interface BatterLine { r: number; b: number; fours: number; sixes: number } // runs, balls faced, boundaries
export interface BowlerLine { b: number; r: number; w: number } // balls, runs conceded, wickets

// The scorecard when the feed starts; scorecard.ts builds its state from it.
export interface CricketStart {
  batting: string;
  bowling: string;
  target: number;
  firstInnings: string;
  runs: number;
  wkts: number;
  balls: number;
  striker: string;
  bowler: string;
  batters: Record<string, BatterLine>;
  bowlers: Record<string, BowlerLine>;
  outs: (BatterLine & { name: string; how: string })[];
}

interface Wicket { out: string; how: string; next: string }
// What a ball or event may carry for the crowd and the feed clock (see SCRIPT). `moment` names a point in the script
// that threads and tests refer to.
interface Cues { crowd?: CrowdCue; pause?: number; moment?: string }
interface BallItem extends Cues {
  kind: 'ball';
  bowler: string;
  bat: string;
  runs: number;
  text: string;
  extra?: 'wd';
  wicket?: Wicket;
  drop?: { by: string };
}
// `bowler`: the bowler an event brings on.
interface EventItem extends Cues {
  kind: 'event';
  type: string;
  label: string;
  text: string;
  bowler?: string;
  wicket?: undefined;
  drop?: undefined;
}
interface OverEndItem { kind: 'overend'; crowd?: undefined; moment?: undefined; wicket?: undefined; drop?: undefined }
// Only balls take wickets or see drops; the undefined fields let code test any item for them.
export type CricketItem = BallItem | EventItem | OverEndItem;
type BallExtra = Omit<BallItem, 'kind' | 'bowler' | 'bat' | 'runs' | 'text'>;
type EventExtra = Omit<EventItem, 'kind' | 'type' | 'label' | 'text'>;

export const TEAMS = {
  MI: { code: 'MI', name: 'Mumbai Indians', logo: 'assets/mi.png' },
  CSK: { code: 'CSK', name: 'Chennai Super Kings', logo: 'assets/csk.png' },
};
const TEAM_CODES = Object.keys(TEAMS);
export const otherTeam = (code: string): string => TEAM_CODES.find((c) => c !== code) ?? code;

// Players fans can pick for their social contest team.
export const SQUADS: Record<string, string[]> = {
  MI: ['Jasprit Bumrah', 'Hardik Pandya', 'Rohit Sharma', 'Suryakumar Yadav', 'Tilak Varma', 'Trent Boult'],
  CSK: ['MS Dhoni', 'Ruturaj Gaikwad', 'Shivam Dube', 'Sanju Samson', 'Dewald Brevis'],
};

// What fans actually call them in chat.
const CALLED: Record<string, string> = { 'Tilak Varma': 'Tilak', 'Hardik Pandya': 'Hardik', 'Rohit Sharma': 'Rohit', 'Suryakumar Yadav': 'Surya', 'Ruturaj Gaikwad': 'Ruturaj', 'Sanju Samson': 'Sanju' };
export const shortName = (name: string) => CALLED[name] || name.split(' ').slice(-1)[0];

// The feed starts after 14 overs of the chase.
export const START: CricketStart = {
  batting: 'CSK',
  bowling: 'MI',
  target: 187,
  firstInnings: 'MI 186/6 (20)',
  runs: 128,
  wkts: 2,
  balls: 84,
  striker: 'Ruturaj Gaikwad',
  bowler: 'Mitchell Santner',
  batters: {
    'Shivam Dube': { r: 41, b: 24, fours: 2, sixes: 3 },
    'Ruturaj Gaikwad': { r: 22, b: 17, fours: 2, sixes: 1 },
  },
  bowlers: {
    'Jasprit Bumrah': { b: 12, r: 14, w: 1 },
    'Trent Boult': { b: 18, r: 27, w: 0 },
    'Mitchell Santner': { b: 18, r: 25, w: 0 },
    'Deepak Chahar': { b: 24, r: 38, w: 1 },
    'Hardik Pandya': { b: 12, r: 21, w: 0 },
    'Tilak Varma': { b: 0, r: 0, w: 0 },
  },
  outs: [
    { name: 'Ayush Mhatre', r: 14, b: 11, fours: 2, sixes: 0, how: 'c Rickelton b Bumrah' },
    { name: 'Sanju Samson', r: 44, b: 32, fours: 4, sixes: 2, how: 'c Naman Dhir b Chahar' },
  ],
};

const B = (bowler: string, bat: string, runs: number, text: string, more: BallExtra = {}): BallItem => ({ kind: 'ball', bowler, bat, runs, text, ...more });
const E = (type: string, label: string, text: string, more: EventExtra = {}): EventItem => ({ kind: 'event', type, label, text, ...more });

// `crowd` = burst of simulated chat (`mi` = share of MI fans).
export const SCRIPT: CricketItem[] = [
  E('start', 'Strategic timeout over', 'CSK need 59 off 36. Shivam Dube is set on 41.', {
    crowd: { key: 'start', n: 8, spread: 6000 }, pause: 4000, moment: 'start',
  }),

  // 15th over: Santner
  B('Mitchell Santner', 'Ruturaj Gaikwad', 1, 'Santner to Gaikwad, worked down to long-on for one.'),
  B('Mitchell Santner', 'Shivam Dube', 6, 'Dube steps out and launches Santner over long-off. Huge.', { crowd: { key: 'six_csk', n: 7 } }),
  B('Mitchell Santner', 'Shivam Dube', 0, 'Flighted, defended back to the bowler.'),
  B('Mitchell Santner', 'Shivam Dube', 6, 'Again! Slog-swept into the second tier at deep midwicket.', { crowd: { key: 'six_csk', n: 9, mi: 0.45 } }),
  B('Mitchell Santner', 'Shivam Dube', 1, 'Pushed to cover, quick single.'),
  B('Mitchell Santner', 'Ruturaj Gaikwad', 2, 'Gaikwad drives into the gap at deep cover and comes back for two.'),
  { kind: 'overend' },

  // 16th over: the bowling change
  E('bowling_change', 'Bowling change', 'Captain Hardik Pandya hands the ball to part-timer Tilak Varma. Jasprit Bumrah still has 2 overs left.', {
    bowler: 'Tilak Varma', crowd: { key: 'bowling_change', n: 24, spread: 10000, mi: 0.55 },
    pause: 4500, moment: 'bowling-change',
  }),
  B('Tilak Varma', 'Shivam Dube', 4, 'Tilak drops short and Dube pulls it through midwicket for four.', { crowd: { key: 'tilak_hit', n: 9 } }),
  B('Tilak Varma', 'Shivam Dube', 6, 'Down the track and over long-on. Tilak is going the distance.', { crowd: { key: 'tilak_hit', n: 11, mi: 0.6 } }),
  B('Tilak Varma', 'Shivam Dube', 1, 'Wide down the leg side.', { extra: 'wd' }),
  B('Tilak Varma', 'Shivam Dube', 1, 'Tucked off the pads to fine leg for one.'),
  B('Tilak Varma', 'Ruturaj Gaikwad', 1, 'Gaikwad pushes to long-off, another single.'),
  B('Tilak Varma', 'Shivam Dube', 0, 'OUT! Dube goes big again and holes out to Suryakumar at long-on. Tilak has his man.', {
    wicket: { out: 'Shivam Dube', how: 'c Suryakumar b Tilak', next: 'Dewald Brevis' },
    crowd: { key: 'tilak_wicket', n: 26, spread: 9000, mi: 0.55 }, pause: 5000, moment: 'tilak-wicket',
  }),
  B('Tilak Varma', 'Dewald Brevis', 1, 'Brevis is off the mark with a nudge to point.'),
  { kind: 'overend' },

  // 17th over: Bumrah is back, DRS drama
  E('bowler', 'Back on', 'Jasprit Bumrah returns for his third over.', { crowd: { key: 'bumrah_back', n: 8 }, pause: 2500 }),
  B('Jasprit Bumrah', 'Dewald Brevis', 0, 'Full and fast, dug out.'),
  B('Jasprit Bumrah', 'Dewald Brevis', 0, 'Big LBW shout! Not out, says the umpire. Hardik reviews straight away.', {
    crowd: { key: 'drs_appeal', n: 10, spread: 3500 }, pause: 4000, moment: 'drs',
  }),
  E('review', 'DRS', "Impact: umpire's call. Not out stands and MI lose their review.", {
    crowd: { key: 'drs_result', n: 18, spread: 8000 }, pause: 3500,
  }),
  B('Jasprit Bumrah', 'Dewald Brevis', 1, 'Brevis squeezes a yorker to third man for one.'),
  B('Jasprit Bumrah', 'Ruturaj Gaikwad', 4, 'Gaikwad opens the face and runs it past short third for four.', { crowd: { key: 'boundary', n: 4 } }),
  B('Jasprit Bumrah', 'Ruturaj Gaikwad', 1, 'Slower ball, pushed to mid-on for one.'),
  B('Jasprit Bumrah', 'Dewald Brevis', 0, 'Bumrah nails the yorker. Dot.', { crowd: { key: 'dot', n: 3 } }),
  { kind: 'overend' },

  // 18th over: Boult, and a dropped catch
  B('Trent Boult', 'Ruturaj Gaikwad', 1, 'Boult to Gaikwad, dropped at his feet for a single.'),
  B('Trent Boult', 'Dewald Brevis', 0, 'Beaten outside off.', { crowd: { key: 'dot', n: 2 } }),
  B('Trent Boult', 'Dewald Brevis', 1, 'Brevis skies it to mid-off... DROPPED! Hardik spills a simple catch. They cross for one.', {
    drop: { by: 'Hardik Pandya' }, crowd: { key: 'drop', n: 20, spread: 8000, mi: 0.6 }, pause: 4500, moment: 'drop',
  }),
  B('Trent Boult', 'Ruturaj Gaikwad', 4, 'Gaikwad makes them pay, flat-batted past mid-off for four.', { crowd: { key: 'boundary', n: 5 } }),
  B('Trent Boult', 'Ruturaj Gaikwad', 1, 'Worked to deep square for one.'),
  B('Trent Boult', 'Dewald Brevis', 2, 'Brevis slices it wide of third man, two.'),
  { kind: 'overend' },

  // 19th over: Bumrah's last, and Dhoni walks in
  E('bowler', 'Back on', 'Jasprit Bumrah for his final over. CSK need 14 off 12.', { crowd: { key: 'tension', n: 6 }, pause: 2500 }),
  B('Jasprit Bumrah', 'Ruturaj Gaikwad', 1, 'Yorker, jammed out to long-on for one.'),
  B('Jasprit Bumrah', 'Dewald Brevis', 0, 'Beats the bat with a slower bouncer.'),
  B('Jasprit Bumrah', 'Dewald Brevis', 0, 'BOWLED HIM! Bumrah sends the middle stump cartwheeling.', {
    wicket: { out: 'Dewald Brevis', how: 'b Bumrah', next: 'MS Dhoni' }, crowd: { key: 'bumrah_wicket', n: 14, spread: 5000 }, pause: 3500,
  }),
  E('walk_in', 'New batter', 'MS Dhoni walks out. The whole stadium is on its feet.', { crowd: { key: 'dhoni_walks', n: 16, spread: 6000, mi: 0.3 }, pause: 4000 }),
  B('Jasprit Bumrah', 'MS Dhoni', 1, 'Dhoni gets a thick edge to third man for one.'),
  B('Jasprit Bumrah', 'Ruturaj Gaikwad', 0, 'Another yorker. Gaikwad can only dig it out.'),
  B('Jasprit Bumrah', 'Ruturaj Gaikwad', 1, 'Single to long-on. Bumrah finishes with 4-0-23-2.'),
  { kind: 'overend' },

  // 20th over
  E('last_over', 'Last over', 'Captain Hardik Pandya will bowl it himself. CSK need 11 off 6.', {
    crowd: { key: 'last_over', n: 16, spread: 7000 }, pause: 5000, moment: 'last-over',
  }),
  B('Hardik Pandya', 'Ruturaj Gaikwad', 2, 'Low full toss, Gaikwad pushes it to deep cover for two.', { crowd: { key: 'tension', n: 5 } }),
  B('Hardik Pandya', 'Ruturaj Gaikwad', 0, 'Wide yorker, Gaikwad swings and misses. 9 off 4.', { crowd: { key: 'tension', n: 6 } }),
  B('Hardik Pandya', 'Ruturaj Gaikwad', 4, 'FOUR! Gaikwad drills it straight past the bowler. 5 off 3.', { crowd: { key: 'boundary', n: 8 } }),
  B('Hardik Pandya', 'Ruturaj Gaikwad', 1, 'Pushed to long-on, they take one. Dhoni on strike, 4 off 2.', { crowd: { key: 'tension', n: 6 } }),
  B('Hardik Pandya', 'MS Dhoni', 0, 'Dhoni swings and misses! 4 needed off the last ball.', { crowd: { key: 'tension', n: 10 }, pause: 4500 }),
  B('Hardik Pandya', 'MS Dhoni', 6, 'Dhoni launches it over long-on... SIX! CSK win off the last ball!', {
    crowd: { key: 'csk_win', n: 28, spread: 10000, mi: 0.4 },
  }),
  E('result', 'Result', 'CSK win by 6 wickets off the final ball.', { pause: 3000 }),
];

// Simulated chat, the way fans actually type it. {need} and {balls} are filled from the scorecard.
export const CROWD = {
  start: {
    CSK: ['59 off 36, ho jayega bhai 💛💛', 'Dube set hai, chill karo 😎', 'ek bada over chahiye bas 🙏', 'Whistle Podu 💛🦁', 'Thala abhi baaki hai 😏🔥'],
    MI: ['Bumrah ke 2 overs bache hain, relax 😤💙', 'ek wicket aur game palat jayega 🔥', 'Paltan ready hai 💙🔥', 'tight bowling chahiye ab 🙏', 'MI MI MI 💙💙'],
  },
  six_csk: {
    CSK: ['DUBEEEE 🔥🔥🔥', 'kya maara hai yaar 😱🚀', 'Dube spin ko khaa jaata hai 😂🔥', 'ball abhi tak hawa mein hai 🚀', 'Dube meri team ka C hai, chalte raho 🙏💛', 'GAME ON 💛💛', 'stadium ke bahar 😱😱'],
    MI: ['Santner ko hatao bhai 😤', 'Dube ko spin kyun de rahe ho yaar 🤦‍♂️', 'itna flight kaun deta hai 😩', 'Santner ka din kharab hai aaj 💀', 'match haath se nikal raha hai 😰'],
  },
  overend: {
    CSK: ['badhiya over 💛', 'RRR neeche aa raha hai 📉😎', 'strike rotate karte raho 👍'],
    MI: ['ab tight over chahiye 😬', 'Bumrah ko lao pls 🙏🙏', 'pressure hum pe hai ab 😰', 'hmm 😶'],
  },
  bowling_change: {
    MI: [
      'TILAK?? Bumrah kahan hai 😡😡', 'Bumrah ke 2 over bache hain aur part-timer laa rahe ho 🤦‍♂️🤦‍♂️', 'season ka sabse bakwaas bowling change 💀',
      'Hardik bhai kya kar rahe ho 😭', 'ye bowling change mistake hai, Dube kha jayega Tilak ko 😤', '16th over mein Bumrah kyun nahi?? 😡',
      'chase mein part-timer?? bold hai bhai 😬', 'captain pe trust rakho, kuch plan hoga 🤞', 'Tilak ka record accha hai lefties ke against actually 🤓',
      'samajh nahi aaya ye bowling change 🤷‍♂️', 'Bumrah ko 18 aur 20 ke liye bacha rahe hain shayad 🤔', 'captaincy blunder loading... ⏳', 'Tilak?? seriously?? 😐',
    ],
    CSK: [
      'thank you Hardik 😂😂', 'Tilak?? free ke runs 🤑', 'Dube ke muh mein paani aa gaya 🤤😂', 'ye bowling change ne match de diya humein 💛🙏',
      '16th over mein part-timer lol 😂', 'captain overs gift kar raha hai 🎁😂', 'smart move actually, Bumrah ko death ke liye bacha rahe 🤔',
      'Tilak vs Dube, popcorn ready 🍿🍿',
    ],
  },
  tilak_hit: {
    MI: ['bola tha na. BOLA THA 😤😤', 'isliye Tilak ko bowling nahi dete 🤦‍♂️', 'Bumrah fine leg pe khada dekh raha hai 💀💀', 'Tilak ko hatao abhi ke abhi 😡', 'bowling change backfire ho gaya 🔥💀', 'Hardik pls 😭🙏'],
    CSK: ['Tilak ko rakho please 🙏😂', 'Dube full feast mode 🍗🔥', 'Tilak pitt raha hai 😂', 'bahut easy hai 😎', 'thank you captain 😂💛'],
  },
  tilak_wicket: {
    MI: [
      'TILAKKKK!!!! GOLDEN ARM 🔥🔥🔥', 'ok ok maine wapas liya 😅🙏', 'captain ka masterstroke?? 🤯', 'Hardik ko pata tha. Hardik ko sab pata hota hai 😎',
      'bowling change pe galat tha main 😅', 'kisne bola tha mistake? 👀👀', 'part-timer ne wicket le liya 😱🔥', 'Tilak > Bumrah confirmed 😂😂',
      'SABSE BADA WICKET 💙💙', 'hum wapas aa gaye 💪💙',
    ],
    CSK: [
      'noooo Dube kyun 😭😭', 'chase mein faltu shot 🤦‍♂️', 'wicket feka hai bhai 😤', 'ye Dube ki galti hai, Tilak ki nahi 😒', 'mera C pick gaya 😭💔',
      '20th tak khelna tha usko 😩', 'part-timer pe bada shot kyun 🤦‍♂️', 'abhi bhi {need} off {balls}, ho jayega 🙏💛',
    ],
  },
  bumrah_back: {
    MI: ['FINALLY Bumrah 🙏🔥', '16th mein aana chahiye tha but ok 😒', 'Boom Boom time 💥💥', 'yorkers please 🎯'],
    CSK: ['dhyan se ab, Bumrah danger hai ⚠️', 'bas nikal do usko 🙏', 'Bumrah ko khelo, doosre end se maaro 🤞'],
  },
  drs_appeal: {
    MI: ['PLUMB hai 😤', 'review lo!! 🙏', 'hitting lag raha hai 🎯', 'OUT OUT OUT ☝️☝️', 'Bumrah kabhi miss nahi karta 🔥'],
    CSK: ['leg ke bahar ja raha hai 100% 🙅‍♂️', 'going down leg 😤', 'no way ye out hai 😬', 'dil muh mein aa gaya 😰😰'],
  },
  drs_result: {
    MI: ["umpire's call PHIR SE 😤😤", 'ball tracking scam hai bhai 🤡', 'iske liye review gawa diya?? 🤦‍♂️', 'review waste kar diya honestly 😒', 'clip kar raha tha yaar, pathetic 😡', 'kyun liya review, leg ke bahar tha 🤷‍♂️'],
    CSK: ["umpire's call ne bacha liya 😮‍💨🙏", 'phew 😅', 'ball tracking ❤️❤️', 'bach gaye!! 💛', 'umpire ka sahi decision 👏', 'review waste, maza aa gaya 😂'],
  },
  drop: {
    MI: ['CATCH CHHOD DIYA captain ne khud 😭😭', 'catches win matches bhai 💔', 'ye kaise chhoot gaya 🤯', 'match wahi gaya 💀', 'Tilak masterstroke ke baad Hardik ne sitter chhod diya 🤦‍♂️', 'dil nahi sambhal raha 😰', 'unbelievable yaar 😩'],
    CSK: ['lifeline mil gayi!! 🙏💛', 'thank you skipper 😂😂', 'Brevis bach gaya 😅', 'yahi moment hai match ka 🔥', 'butter fingers lol 🧈😂'],
  },
  bumrah_wicket: {
    MI: ['BUMRAHHH 🔥🔥🔥', 'yorker machine 🎯💥', 'isliye 16th mein dena chahiye tha 😤', 'kya bowler hai yaar 🐐', 'game ON!! 💙'],
    CSK: ['nahiii 😭', 'unplayable 😩', 'ab {need} off {balls} 😬😬', 'Thala aa raha hai 🦁🔥 sab theek ho jayega'],
  },
  dhoni_walks: {
    CSK: ['THALAAAA 🦁🦁🦁', 'DHONI DHONI DHONI 📣📣', 'ab dekho 😎🔥', 'Thala for a reason 💛', 'goosebumps 😭🙏', 'Mahi aa gaya, match khatam 😎', 'stadium hil gaya 📣💛'],
    MI: ['Dhoni aa gaya, darr lag raha hai 😰', 'Bumrah ab Thala ko yorker daal 🎯', 'Dhoni ko strike mat do 🙏', 'ab asli test 😬'],
  },
  last_over: {
    MI: ['captain khud last over 😬😬', 'Hardik ab deliver karo 🙏', 'bas wide yorkers daalo 🎯', 'dekha nahi ja raha 🙈', '{need} defend karo bhai 💙'],
    CSK: ['{need} off 6, ho jayega 💛🙏', 'Gaikwad finish karo 🙏', 'ek boundary aur match humara 🔥', 'nervous hoon yaar 😰', 'Thala non-striker pe hai, chill 😎🦁'],
  },
  csk_win: {
    MI: ['heartbreak 💔💔', 'drop ne match haraya 😭', 'Bumrah deserved better 😔', '16th over le dooba 🤦‍♂️', 'gg, kya match tha yaar 👏'],
    CSK: ['JEET GAYE!!! 💛💛💛', 'THALA FOR A REASON 🦁🔥🔥', 'Dhoni Dhoni Dhoni 🙏🙏', 'last ball six!!! 😱😱', 'Gaikwad ne match mein rakha 👏', 'season ka best chase 💛🔥', 'thank you Hardik drop ke liye 😂😂', 'Whistle Podu 🥳💛'],
  },
  boundary: {
    CSK: ['shot!! 🔥', 'four!! chalte raho 💛', 'yehi chahiye 👏', 'beauty 😍'],
    MI: ['bahut short tha 😤', 'yorker daalo yaar 🎯', 'loose ball 🤦‍♂️', 'ab dot balls chahiye 🙏'],
  },
  dot: {
    CSK: ['dot ball pressure 😬', 'strike rotate karo yaar 🙏', 'singles chahiye 😩'],
    MI: ['accha ball 👏', 'dabao inko 💪', 'tight 🔥'],
  },
  tension: {
    CSK: ['{need} off {balls} 😬', 'saans ruk gayi hai 😰', 'ek bada shot please 🙏', 'come on Ruturaj 💛'],
    MI: ['{need} defend karo 💙', 'nerves pakad ke rakho 😤', 'singles chalega, boundary nahi 🙏', 'ek wicket aur 🔥'],
  },
  chatter: {
    CSK: ['office se dekh raha hoon koi aur? 😅', 'dew aa rahi hai, chase easy hoga 💧', 'mere social contest team ko Dube ke 50+ chahiye 🙏', '@BoundaryBhaiya prediction batao bhai?', 'Ruturaj touch mein lag raha hai 👌', 'pitch slow ho rahi hai 🤔'],
    MI: ['Bumrah meri team mein hai, bowling do pls 🙏', 'koi bhi wicket chahiye bas 😩', 'field bahut defensive hai 🤦‍♂️', 'Surya ke 70 waste nahi hone chahiye 😤', 'shaadi mein phone pe dekh raha hoon lol 😂📱', 'pitch slow hai, humare liye accha 💙'],
  },
};

// Hand-written simulated fans, by side.
const HANDLES = {
  CSK: ['riya_sixes', 'chepauk_dreams', 'thala_bhakt_7', 'dhruv_da_fan', 'anu_whistles', 'sid_cover_drive', 'yellove_arjun', 'harsh_hooks',
    'kavya_kc', 'rahul_rrr', 'mahi_way', 'manav_memes', 'priya.p', 'farhan_fc', 'lakshmi.l', 'tara_t'],
  MI: ['kunal.k', 'wankhede_wala', 'paltan_pooja', 'tanvi_t20', 'yashraj.cric', 'boom_boom_fan', 'nikz', 'zoya.cricket',
    'ishaan.in', 'sana_slower_ball', 'neha_nets', 'ojas_ultras', 'divya_dotball', 'adi_bluearmy', 'jay_yorkers', 'sky_ka_fan'],
};

export const FANS = Object.entries(HANDLES).flatMap(([team, handles]) => handles.map((handle) => ({ handle, team })));
