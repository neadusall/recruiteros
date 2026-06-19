/**
 * RecruitersOS · Copy guidelines (the ONE source of truth for outreach voice)
 *
 * This is the living rule book. It feeds TWO things from one place:
 *   1. GENERATION — `GUIDELINES_PROMPT` is injected into every LLM drafter's system
 *      prompt, so copy is written to the rules.
 *   2. ENFORCEMENT — the machine-checkable rule lists below power the deterministic
 *      scanner (lib/copy/guardrail) and the critic (lib/copy/critic), so we CHECK
 *      that the LLM actually obeyed, on the auto-send path, before anything ships.
 *
 * When the operator gives a new rule ("never say X", "always do Y"), it gets added
 * HERE — and propagates to both generation and checking automatically. These are the
 * ongoing notes that stop the same mistakes recurring. Truth is non-negotiable: every
 * rule serves making the copy honest, specific, and human, never deceptive.
 *
 * Composes with HOUSE_VOICE (craft) + BD_POSITIONING (the flip) in lib/bd/houseVoice.
 */

export interface CopyRule {
  id: string;
  /** Why it's banned, in plain words (also shown to the self-repair + critic). */
  why: string;
  /** Case-insensitive matcher. A hit is a violation. */
  test: RegExp;
}

/**
 * HOLLOW OPENERS / FAKE REASONS — the #1 tell of a template. The reason for reaching
 * out must always be a real, specific, verifiable observation about THEM. If there is
 * no real reason, say nothing rather than manufacture warmth.
 */
export const HOLLOW_OPENERS: CopyRule[] = [
  { id: "came_to_mind", why: "hollow reason — you came to mind / thought of you", test: /\b(you|they)\s+came\s+to\s+mind\b|\bcame\s+to\s+mind\b/i },
  { id: "thought_of_you", why: "hollow reason — thought of you", test: /\bthought\s+(of|about)\s+you\b/i },
  { id: "reminded_me", why: "hollow reason — reminded me of you", test: /\bremind(ed|s)?\s+me\s+of\s+you\b/i },
  { id: "find_interesting", why: "hollow reason — thought you'd find this interesting", test: /\byou(?:'?d| would)\s+find\s+(this|it|that)\s+(interesting|useful|valuable)\b/i },
  { id: "wanted_to_reach_out", why: "hollow opener — wanted to reach out", test: /\bwant(ed|ing)?\s+to\s+reach\s+out\b/i },
  { id: "reach_out_directly", why: "hollow opener — figured I'd reach out directly", test: /\b(figured|thought)\s+I(?:'?d| would)\s+reach\s+out\b|\breach\s+out\s+directly\b/i },
  { id: "just_checking_in", why: "hollow opener — just checking in / touching base", test: /\b(just\s+)?(checking\s+in|touching\s+base|following\s+up)\b/i },
  { id: "came_across_background", why: "hollow opener — came across your background/profile", test: /\bcame\s+across\s+your\s+(background|profile|name|work|experience)\b/i },
  { id: "hope_finds_you", why: "filler — hope this email finds you well", test: /\bhope\s+(this|you|your)\b[^.?!]{0,30}\b(finds?\s+you|are\s+well|is\s+well)\b/i },
  { id: "keep_warm", why: "hollow filler — I keep strong people warm / keep you in mind", test: /\bkeep\s+(you|strong\s+\w+|good\s+\w+|great\s+\w+|them)\b[^.?!]{0,20}\b(warm|in\s+mind|on\s+(my|the)\s+radar)\b/i },
  { id: "introduce_myself", why: "weak opener — wanted to introduce myself", test: /\bwant(ed)?\s+to\s+introduce\s+myself\b/i },
  { id: "pick_your_brain", why: "cliche ask — pick your brain", test: /\bpick\s+your\s+brain\b/i },
  { id: "quick_question", why: "bait opener — quick question", test: /\bquick\s+question\b/i },
  { id: "circle_back", why: "salesy filler — circle back", test: /\bcircle\s+back\b/i },
];

/**
 * FABRICATED REFERRAL / SOCIAL PROOF — NEVER imply a referral, intro, or that you
 * heard something private unless it is REAL and a source is attached to the prospect.
 * Faking "you came recommended" is deception and torches trust the moment it's caught.
 * These are allowed ONLY when `hasRealReferralSource` is true (a genuine referrer).
 */
export const FABRICATED_REFERRAL: CopyRule[] = [
  { id: "came_recommended", why: "fabricated referral — came recommended", test: /\bcame\s+(highly\s+)?recommended\b/i },
  { id: "recommended_you", why: "fabricated referral — someone recommended you", test: /\b(\w+\s+)?recommended\s+(you|that\s+I\s+(reach|connect|speak))\b/i },
  { id: "were_referred", why: "fabricated referral — you were referred", test: /\b(you\s+(were|got)\s+referred|referred\s+(to|me\s+to)\s+you)\b/i },
  { id: "name_came_up", why: "fabricated referral — your name came up", test: /\b(your\s+name|you)\s+came\s+up\b/i },
  { id: "someone_mentioned", why: "fabricated referral — someone mentioned you", test: /\b(someone|a\s+\w+|people)\s+mention(ed|s)?\s+(you|your\s+name)\b/i },
  { id: "heard_youre_hiring", why: "fabricated pretext — I heard you're hiring", test: /\bI\s+heard\s+(you(?:'?re| are)\s+(hiring|looking|growing)|that\s+you)\b/i },
  { id: "mutual_connection", why: "implied/false mutual connection", test: /\b(a\s+)?mutual\s+(connection|friend|contact)\b|\bwe\s+were\s+connected\s+by\b/i },
];

/** FORMATTING — plain text only. Dashes are handled by lib/text/dashes (hasDash). */
export const FORMAT_RULES: CopyRule[] = [
  { id: "emoji", why: "no emojis in outreach", test: /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u },
  { id: "hashtag", why: "no hashtags in outreach", test: /(^|\s)#[A-Za-z]\w+/ },
];

/** The full machine-checkable set the scanner walks (referral set gated by caller). */
export const ALL_RULES = { HOLLOW_OPENERS, FABRICATED_REFERRAL, FORMAT_RULES };

/**
 * GUIDELINES_PROMPT — injected (cached) into every drafter so copy is WRITTEN to the
 * rules. Kept tight; the craft + positioning live in HOUSE_VOICE / BD_POSITIONING.
 */
export const GUIDELINES_PROMPT = `OUTREACH GUIDELINES (hard rules, non-negotiable):
- THE REASON IS REAL OR ABSENT. The reason for reaching out is always a specific, verifiable observation about THEM: their actual work, a real public signal (a post, a funding round, a launch, a role they led). If you have no real reason, say nothing about why; never manufacture one.
- BANNED hollow openers and anything like them: "you came to mind", "thought of you", "reminded me of you", "wanted to reach out", "figured I'd reach out", "reach out directly", "just checking in", "touching base", "following up", "came across your background/profile", "hope this finds you", "keep you warm", "keep you in mind", "introduce myself", "pick your brain", "quick question", "circle back". They read as a template and kill trust.
- NEVER fabricate a referral, intro, or private knowledge: no "came recommended", "so-and-so recommended you", "you were referred", "your name came up", "someone mentioned you", "I heard you're hiring", "a mutual connection". Only state a referral when one genuinely exists and the real name is provided. Faking it is deception and is caught the moment they ask "who?".
- Specificity is what makes a message feel warm and earned (like a real intro). Anchor on one concrete, true detail about them and lead with the insight, not the introduction.
- Plain text only. No emojis, no hashtags, NO dashes of any kind (em, en, or hyphen; write compounds as separate words). US dollars with $.`;

/**
 * CRITIC_SYSTEM — the Haiku judge. It catches what regex can't: generic, salesy, or
 * "off-voice" copy that technically dodged the banned list but still reads like a bot.
 */
export const CRITIC_SYSTEM = `You are the final quality gate for outreach copy from a recruiting and talent advisory firm (Ryan / Lume) before it sends automatically with no human review. Judge ONLY the copy given, against these standards:

PASS only if ALL hold:
- The reason for reaching out is a real, specific, verifiable detail about the recipient (their work, a public signal), OR there is no stated reason at all. NOT a manufactured one.
- It does NOT imply a referral, intro, or private knowledge unless one is genuinely provided.
- It reads like a sharp, busy peer wrote it to ONE person: specific, warm, low-friction, easy out. Not generic, not salesy, not a template, not fawning.
- Plain text: no emojis, no hashtags, no dashes of any kind.
- One clear, optional ask at most. Truthful throughout (no invented facts, numbers, names, outcomes).

FAIL if it sounds like a bot, is generic enough to send to anyone, manufactures a reason or referral, hypes, or breaks formatting.

Respond as strict JSON only:
{ "pass": boolean, "issues": string[], "rewrite": string }
- issues: short, concrete reasons it failed (empty if pass).
- rewrite: if it fails, a corrected version that fixes every issue while keeping it truthful and grounded ONLY in the facts present in the original. If it passes, repeat the original unchanged.`;
