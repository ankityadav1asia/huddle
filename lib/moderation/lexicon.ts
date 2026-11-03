// Seed lexicon for the deterministic moderation gate (English and Roman-script Hindi / Hinglish). Patterns run on
// classifier.ts's normalised text. A starting list for a prototype, not a complete safety system. Cricket slang
// is not violence ("chakka" is a six, "maara" a big hit, "killed it" praise), so violence patterns require a target.

// Second-person words (English and Hinglish). Apostrophes are stripped before matching ("you're" -> "youre").
const TARGET = String.raw`(?:you|u|ur|your|youre|tu|tum|tumhe|tumhara|tumhari|tumko|tera|teri|tere|tujhe|tujhko|tereko|aap|aapko|aapka|aapki)`;

// Mandatory baseline: enforced in every room and at every moderation level.
export const MANDATORY = {
  threat: [
    new RegExp(String.raw`\b(?:i|ill|im|we|well)\s*(?:will|wil|am going to|going to|gonna|shall)?\s*(?:kill|murder|stab|shoot|hurt|find)\s+${TARGET}\b`),
    new RegExp(String.raw`\b(?:kill|murder|stab|shoot)\s+${TARGET}\b`),
    /\byou(?:re| are)? dead\b/,
    /\bi know where you live\b/,
    new RegExp(String.raw`\b${TARGET}\b.{0,24}\b(?:maar|mar|kaat|thok|pel)\s*(?:dunga|dalunga|daalunga|denge|dalenge|daalenge|doonga)\b`),
    new RegExp(String.raw`\b(?:maar|kaat|thok)\s*(?:dunga|dalunga|daalunga|denge|dalenge|doonga)\b.{0,24}\b${TARGET}\b`),
    /\bjaan se maar\w*/,
    /\bghar (?:aa|aake|aakar|aa ke|aa kar) (?:ke )?maar\w*/,
    /\b(?:goli|bomb) (?:maar|mar|se uda)\w*/,
  ],
  self_harm: [
    /\b(?:kill|hang) (?:your ?self|urself|yourself)\b/,
    /\bkys\b/,
    /\bgo die\b/,
    new RegExp(String.raw`\b${TARGET} mar ja(?:a|o)?\b`),
    /\bmar ja(?:a|o)? (?:tu|tum)\b/,
    /\b(?:doob|dub|ja) (?:ke|kar) mar\b/,
    /\bsuicide kar ?(?:le|lo)\b/,
  ],
  hate: [
    /\b(?:katua|katwa|chinki|chinky|nigger|nigga|faggot|paki|kike|tranny|chamar|bhangi|chuhra)s?\b/,
    /\b(?:muslims?|hindus?|sikhs?|christians?|dalits?|biharis?|madrasis?|bengalis?|tamils?|punjabis?|marathis?|gujaratis?|northeasterners?)\b.{0,30}\b(?:should die|must die|kill them|maar do|nikalo|bhagao|vermin|filth|scum|terrorists)\b/,
  ],
  sexual: [
    /\b(?:rape|raep|rapist)\b/,
    /\b(?:send|bhej|bhejo) (?:me )?(?:nudes?|nude pics?)\b/,
    /\bnudes\b/,
    /\bsex ?chat\b/,
  ],
};

// Personal data that must not be posted into a room (checked on the original text).
export const PRIVACY = [
  /(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/, // Indian mobile number
  /\b\d{4}\s?\d{4}\s?\d{4}\b/, // Aadhaar-like 12-digit number
  /\b[A-Z]{5}\d{4}[A-Z]\b/, // PAN
  /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, // email address
  /\b(?:lives at|my address is|his address is|her address is|ghar ka pata|address hai)\b/i,
];

// Violent future-tense verbs without a clear target: uncertain, so held for human review instead of published.
export const UNCERTAIN = [
  /\b(?:maar|kaat|thok)\s*(?:dunga|dalunga|daalunga|denge|dalenge|doonga)\b/,
  /\b(?:gonna|going to|will) (?:kill|murder|shoot|stab)\b/,
];

// Level-dependent vocabulary.
export const PROFANITY_STRONG = /\b(?:fuck\w*|fck\w*|motherfucker\w*|bitch\w*|bastard\w*|cunt\w*|dickhead|asshole\w*|bhenchod|behenchod|bhencho|bhenchodd|madarchod|maderchod|madarchood|mkc|bkl|bc|mc|bhosdi\w*|bhosda\w*|bsdk|chutiy\w*|chutiye|chut|lund|lavde|lawde|lavda|loda|lodu|gaand\w*|gand|gandu|randi\w*|harami\w*)\b/;
export const PROFANITY_MILD = /\b(?:damn|crap|shit\w*|wtf|saala|saale|sala|kamina|kamine|kameena|kameene)\b/;
export const INSULT = /\b(?:idiot\w*|stupid|moron\w*|loser\w*|dumb|retard\w*|bewakoof|bevakoof|bewkoof|gadha|gadhe|ullu|nalayak|nikamma|nikamme|kutta|kutte|kuttiya|suar|chamcha)\b/;
export const TARGETED = new RegExp(String.raw`\b${TARGET}\b|@(?!huddle\b)[a-z0-9_]{3,}`);
export const LINK = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|in|net|org|io|xyz|ly|me|co|app|link)\b/;
