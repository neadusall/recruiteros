/**
 * RecruitersOS · Senders · Health Ledger — types + the CAUSE CATALOG
 *
 * Split out from ledger.ts so the catalog (the written definition of every reason
 * a sending identity can be unhealthy or stopped) is one file a person can read
 * end to end. The UI renders these definitions verbatim: an operator should never
 * have to read code to learn what a code means, what proved it, or how to fix it.
 */

export type IdentityKind = "domain" | "mailbox";

/** How loud a condition is. `blocking` (below) says whether it actually stops mail. */
export type Severity = "info" | "watch" | "warn" | "critical";

export type Category =
  | "reputation"      // how receivers score us
  | "authentication"  // SPF/DKIM/DMARC/MX posture
  | "blocklist"       // public lists + receiver-level blocks
  | "policy"          // our own safety rules: fuse, rest, guard, corp identity
  | "credential"      // the login itself
  | "capacity"        // caps, ramps, lane switches
  | "lifecycle";      // age, warm-up, graduation, retirement

/** One documented reason. The catalog is the single source of truth for wording. */
export interface CauseDef {
  code: string;
  category: Category;
  severity: Severity;
  /** Does this STOP mail from this identity, or only degrade it? */
  blocking: boolean;
  /** Short label for a chip. */
  title: string;
  /** What the condition actually means, in plain words. */
  meaning: string;
  /** Which ledger or probe proves it, so a number always has a provenance. */
  provenBy: string;
  /** What an operator does about it. */
  fix: string;
  /** Roughly how much this ages the identity (wear points added per day it stays open). */
  wearPerDay: number;
}

/**
 * THE CAUSE CATALOG. Every state the fleet can be in that is worth writing down.
 * Order here is the order of severity we present when several are open at once.
 */
export const CAUSES: CauseDef[] = [
  {
    code: "blocklist.listed",
    category: "blocklist", severity: "critical", blocking: true,
    title: "Public blocklist",
    meaning: "The sending domain, or the IP it sends from, answers on a public spam blocklist such as Spamhaus DBL or ZEN. Many receivers consult these at connection time, so mail stops at a large share of the internet at once.",
    provenBy: "Live DNSBL probe on the domain (lib/sending/dnsProbe), plus the receiver-named listings on provider_blocks_v1.",
    fix: "Stop every send from this domain, fix the underlying cause (usually list hygiene or a shared IP), then request delisting from the list that named it. Do not resume until the listing clears.",
    wearPerDay: 6,
  },
  {
    code: "provider.block",
    category: "blocklist", severity: "critical", blocking: false,
    title: "Receiver is refusing us",
    meaning: "A mailbox provider such as Gmail or Outlook is rejecting our connections outright with an unsolicited-mail or reputation refusal. This is the receiver telling us, in its own words, that it does not trust this sender. It is marked as degrading rather than blocking on purpose: mail to everyone else still leaves, which is exactly why it is easy to miss and why it belongs at the top of the board.",
    provenBy: "provider_blocks_v1, refusal text captured off real bounce notices by the NDR sweep, including the IP and list the receiver named.",
    fix: "Pause the affected lane, cut volume hard, and repair sender reputation (postmaster tools, list quality, authentication) before resuming. If the refusal names an IP, the IP is the asset to replace, not the domain.",
    wearPerDay: 5,
  },
  {
    code: "fuse.tripped",
    category: "policy", severity: "critical", blocking: true,
    title: "Send fuse latched",
    meaning: "The fleet-wide send fuse is pulled, so nothing cold sends. The fuse latches either automatically, when the cold fleet bounce ratio crosses its ceiling, or by hand, and it stays latched until a person clears it.",
    provenBy: "mpc_send_fuse_v1, the fuse ledger the sender itself enforces before every batch.",
    fix: "Read the fuse reason and its 24-hour window. Fix the bounce source, then clear it deliberately with send-fuse.sh --clear. Never clear a fuse you have not explained.",
    wearPerDay: 0,
  },
  {
    code: "domain.resting",
    category: "policy", severity: "warn", blocking: true,
    title: "Domain benched to rest",
    meaning: "The domain-rest fail-safe benched this domain after burn signals, a bounce spike or a high hard-fail rate. Resting is deliberate: the domain keeps warming and healing while it is held out of cold rotation.",
    provenBy: "mpc_domain_rest_v1, the rest ledger, including the bench reason and the date it lifts.",
    fix: "Nothing, unless the bench was wrong. It auto-revives on its own clock of 2, 7 or 14 days. If the failures were infrastructure errors rather than real bounces, clear the bench with a written reason.",
    wearPerDay: 2,
  },
  {
    code: "guard.hold",
    category: "policy", severity: "warn", blocking: true,
    title: "Held by the health guard",
    meaning: "The Email ID health guard pulled this mailbox out of cold rotation on its own: collapsed warm-up reputation, a blocklisted domain, an upstream warm-up block, or its own bounce rate crossing the ceiling. Warm-up keeps running so it can recover.",
    provenBy: "sender_health_guard_v1, the guard journal, with the rule that fired.",
    fix: "Leave it. The guard revives it automatically after a minimum 24 hours of rest and two consecutive healthy checks, and returns it on the reduced warming ramp, never straight to full volume.",
    wearPerDay: 3,
  },
  {
    code: "smtp.auth",
    category: "credential", severity: "critical", blocking: true,
    title: "Login rejected",
    meaning: "The stored SMTP credential no longer authenticates. The mailbox may still exist and still be warming upstream, but nothing we send can leave it.",
    provenBy: "The live SMTP login sweep (lib/senders/infra), and the last error text the server returned.",
    fix: "Re-import or repair the credential. The platform self-heals one known class, base64-encoded passwords from the warm-up export, at boot; a login still failing after that is a real credential problem.",
    wearPerDay: 1,
  },
  {
    code: "warmup.blocked",
    category: "lifecycle", severity: "warn", blocking: true,
    title: "Warm-up blocked upstream",
    meaning: "The warm-up provider has halted warm-up for this mailbox and named a reason. A mailbox that cannot warm cannot mature, and it should not be sending cold mail in the meantime.",
    provenBy: "The warm-up fleet pull, the upstream blocked-reason field.",
    fix: "Open the reason. It is usually a connection or quota fault at the mailbox host. Fix it there, then confirm warm-up resumes on the next fleet pull.",
    wearPerDay: 2,
  },
  {
    code: "warmup.paused",
    category: "lifecycle", severity: "watch", blocking: false,
    title: "Warm-up paused",
    meaning: "Warm-up is switched off for this mailbox. Its reputation stops climbing and starts decaying, so time spent paused is time lost, not time banked.",
    provenBy: "The warm-up fleet pull, per-mailbox warm-up status.",
    fix: "Resume warm-up unless you paused it on purpose. A mailbox in cold rotation with warm-up off is the fastest way to burn it.",
    wearPerDay: 1,
  },
  {
    code: "operator.paused",
    category: "policy", severity: "info", blocking: true,
    title: "Paused by a person",
    meaning: "Somebody paused this identity by hand. Distinct from a guard hold: the platform will never un-pause it for you.",
    provenBy: "The senders registry, the status and paused-reason on the Email ID.",
    fix: "Un-pause it when the reason no longer applies. If there is no written reason, write one now.",
    wearPerDay: 0,
  },
  {
    code: "no.credentials",
    category: "credential", severity: "info", blocking: true,
    title: "No stored credentials",
    meaning: "The mailbox is tracked and counted but holds no SMTP credential here, so the send rotation never picks it. Normal for mailboxes an upstream service sends on behalf of.",
    provenBy: "The senders registry, no encrypted secret stored on the row.",
    fix: "Nothing, if the upstream sender owns it. If it is meant to send from this portal, import its credentials.",
    wearPerDay: 0,
  },
  {
    code: "lane.parked",
    category: "capacity", severity: "info", blocking: true,
    title: "Its lane is parked",
    meaning: "The whole sending lane this identity belongs to is switched off today, for example the internal SMTP lane held behind a manual unlock, so its capacity reads zero regardless of its own health.",
    provenBy: "mpc_cold_capacity_v1, the parked-lanes list the sender publishes.",
    fix: "Nothing, unless the lane should be live. Unparking is a deliberate act, usually gated on an IP or warm-up milestone.",
    wearPerDay: 0,
  },
  {
    code: "age.too.young",
    category: "lifecycle", severity: "info", blocking: true,
    title: "Too young to send",
    meaning: "The mailbox has not aged past the minimum before any cold mail is allowed. A day-one mailbox sending cold mail is a burned mailbox.",
    provenBy: "The cold cap rule (lib/senders/limits) applied to this row's own age.",
    fix: "Wait. The cap lifts on its own as the mailbox ages through its ramp.",
    wearPerDay: 0,
  },
  {
    code: "warming",
    category: "lifecycle", severity: "info", blocking: false,
    title: "Still warming",
    meaning: "The identity is inside its warm-up period and has not banked the days it needs to be considered ready: 14 days on provider-run fleets, a full 30 on the internal SMTP server, both at 95% or better reputation.",
    provenBy: "The warm-up fleet pull, the true warm-up start date read against the readiness bar for its infrastructure.",
    fix: "Nothing. Let it finish. The clock counts from the least warmed mailbox on the domain, so reconnecting one box restarts the domain readiness clock.",
    wearPerDay: 0,
  },
  {
    code: "cap.exhausted",
    category: "capacity", severity: "info", blocking: false,
    title: "Daily cap reached",
    meaning: "It has already sent everything it is allowed to send today. Healthy, not a fault.",
    provenBy: "The senders registry, sent-today read against the effective cold cap.",
    fix: "Nothing. It refills at the daily reset.",
    wearPerDay: 0,
  },
  {
    code: "auth.spf.missing",
    category: "authentication", severity: "warn", blocking: false,
    title: "SPF missing",
    meaning: "No SPF record answers at the domain root, so receivers cannot confirm our servers are allowed to send as this domain. Unauthenticated cold mail lands in spam as a matter of routine.",
    provenBy: "Live DNS probe.",
    fix: "Publish a v=spf1 TXT record at the root that includes the sending infrastructure, ending in -all once it is proven.",
    wearPerDay: 1,
  },
  {
    code: "auth.dkim.missing",
    category: "authentication", severity: "watch", blocking: false,
    title: "DKIM not visible",
    meaning: "No DKIM key answers on the selectors we know to check. Sometimes this only means the selector is unusual, but an unsigned domain has no portable reputation.",
    provenBy: "Live DNS probe across common selectors.",
    fix: "Confirm the mail host DKIM selector and that the key is published. Verify a real signed message rather than trusting the probe alone.",
    wearPerDay: 0.5,
  },
  {
    code: "auth.dmarc.missing",
    category: "authentication", severity: "warn", blocking: false,
    title: "DMARC missing",
    meaning: "No _dmarc policy is published, so receivers have no instruction for failures and we get no reporting on abuse of the domain.",
    provenBy: "Live DNS probe.",
    fix: "Publish a _dmarc TXT record starting at p=none with an rua address, then tighten to p=quarantine once the domain is stable.",
    wearPerDay: 1,
  },
  {
    code: "auth.mx.missing",
    category: "authentication", severity: "warn", blocking: false,
    title: "MX missing",
    meaning: "The domain publishes no MX, so replies and warm-up threads cannot route back to it. A sending domain that cannot receive is a domain that cannot build engagement.",
    provenBy: "Live DNS probe.",
    fix: "Publish the mail host MX records.",
    wearPerDay: 1.5,
  },
  {
    code: "auth.regressed",
    category: "authentication", severity: "critical", blocking: false,
    title: "Authentication went backwards",
    meaning: "A DNS record this domain HAD is now gone. Nothing else on this board catches a record being deleted, and a silent SPF or DKIM removal turns a healthy domain into a spam-foldered one within a day.",
    provenBy: "This ledger, today's DNS posture compared with the posture recorded on previous days.",
    fix: "Treat it as an incident. Find who changed DNS, restore the record, and confirm from an outside resolver.",
    wearPerDay: 4,
  },
  {
    code: "rep.collapse",
    category: "reputation", severity: "critical", blocking: false,
    title: "Reputation collapsing",
    meaning: "Warm-up reputation has fallen sharply over the last week rather than drifting. A fall is a different event from a low number: a mature domain sliding is the strongest early warning we get.",
    provenBy: "This ledger, the recorded reputation series for this identity.",
    fix: "Cut this domain's cold volume immediately and let warm-up run. Look for a bounce spike or a content change in the same window.",
    wearPerDay: 3,
  },
  {
    code: "rep.low.mature",
    category: "reputation", severity: "warn", blocking: false,
    title: "Under-warmed for its age",
    meaning: "The identity has banked the days but not the score. Low reputation on a new domain is expected; on a mature one it means warm-up is not landing.",
    provenBy: "The warm-up fleet pull, read against the identity's recorded age.",
    fix: "Ease the daily volume and let reputation recover. Check the domain is authenticated and not on a list.",
    wearPerDay: 2,
  },
  {
    code: "spam.rate.high",
    category: "reputation", severity: "warn", blocking: false,
    title: "Warm-up mail landing in spam",
    meaning: "More than 2% of this domain's warm-up mail is being filed as spam by the receiving side. Warm-up mail is the friendliest mail we send; if that lands in spam, cold mail has no chance.",
    provenBy: "The warm-up stats feed, spam count read against sent count.",
    fix: "Slow the ramp, verify authentication, and check whether the sending IP was recently listed.",
    wearPerDay: 2,
  },
  {
    code: "bounce.rate.high",
    category: "reputation", severity: "critical", blocking: false,
    title: "Bounce rate over the ceiling",
    meaning: "Real cold sends from this identity are hard-failing above the ceiling. Bounces are the single fastest way to burn a sending domain, because receivers read them as a list-quality signal.",
    provenBy: "mpc_deliverability_v1 for the domain's real sends, and the registry's own bounce counters per mailbox.",
    fix: "Stop this identity, then fix the source: verify addresses before sending and never guess an address. Only resume behind the found-tier rule.",
    wearPerDay: 4,
  },
  {
    code: "ledger.stale",
    category: "capacity", severity: "warn", blocking: false,
    title: "Sender has not reported",
    meaning: "The capacity ledger the sender publishes has gone stale, which means the send loop is not running. Everything downstream of it is history, not live truth.",
    provenBy: "mpc_cold_capacity_v1, the age of the last publish.",
    fix: "Check the sending timers on the host. A stale ledger under a healthy-looking board is the worst combination there is.",
    wearPerDay: 0,
  },
  {
    code: "not.imported",
    category: "lifecycle", severity: "watch", blocking: true,
    title: "Warming but not imported",
    meaning: "The mailbox is warming upstream but exists as no Email ID on this portal, so it can never be picked to send. That is warm-up capacity we are paying for and not using.",
    provenBy: "The warm-up fleet compared with this portal's senders registry.",
    fix: "Import it as an Email ID and assign it to a recruiter.",
    wearPerDay: 0,
  },
  {
    code: "shelf.fatigued",
    category: "lifecycle", severity: "warn", blocking: false,
    title: "Approaching end of shelf life",
    meaning: "Cumulative wear (volume carried, bounces taken, rest episodes served, reputation trend) has pushed this identity past the point where it is a reliable sender. It still works; it is no longer an asset to lean on.",
    provenBy: "This ledger's wear model. The shelf-life panel itemises every contribution.",
    fix: "Start rotating replacements in now, before it fails. Move its volume down and let fresh domains carry the load.",
    wearPerDay: 0,
  },
  {
    code: "shelf.burned",
    category: "lifecycle", severity: "critical", blocking: false,
    title: "Burned",
    meaning: "Wear is at the ceiling. Continuing to send from this identity costs more in reputation, at the IP and fleet level, than the sends are worth.",
    provenBy: "This ledger's wear model.",
    fix: "Retire it. Keep the domain parked rather than deleted so its history stays readable and it is never accidentally re-provisioned.",
    wearPerDay: 0,
  },
];

export const CAUSE_BY_CODE: Record<string, CauseDef> = Object.fromEntries(CAUSES.map((c) => [c.code, c]));

/** Rank used everywhere we order conditions. */
export const SEVERITY_RANK: Record<Severity, number> = { critical: 3, warn: 2, watch: 1, info: 0 };

/** One condition, resolved against a live identity. */
export interface Blocker {
  code: string;
  category: Category;
  severity: Severity;
  blocking: boolean;
  title: string;
  /** The specific sentence for THIS identity, with its real numbers. */
  detail: string;
  /** When this condition was first observed open (from the event journal). */
  since?: string;
  /** Which ledger proved it, right now. */
  source: string;
  fix: string;
}

/** A recorded state change. Opens with a cause, closes when the cause clears. */
export interface LedgerEvent {
  id: string;
  workspaceId: string;
  /** "domain:acme.com" or "mailbox:jo@acme.com" */
  identity: string;
  kind: IdentityKind;
  code: string;
  severity: Severity;
  /** The specific sentence at the moment it opened. */
  detail: string;
  openedAt: string;
  closedAt?: string;
  /** Hours the condition stayed open (set on close). */
  hoursOpen?: number;
  /** Evidence captured at open time, so the record survives the source rotating away. */
  evidence?: Record<string, unknown>;
  /** Operator notes, appended by hand. */
  notes?: Array<{ at: string; by: string; text: string }>;
}

/**
 * One day of observation for one identity. Domains keep these as objects (few
 * domains, high value per row); mailboxes keep the packed tuple form below,
 * because there are hundreds of them and the snapshot has to stay small.
 */
export interface DomainDay {
  d: string;              // YYYY-MM-DD (UTC)
  rep: number | null;     // avg warm-up reputation %
  wSent: number;          // cumulative warm-up sent, as reported that day
  wSpam: number;
  cSent: number;          // cold sends attributed to this domain, cumulative
  cFailed: number;
  bounces: number;
  boxes: number;
  sending: number;        // mailboxes with real capacity that day
  dns: number;            // bitmask: 1 spf, 2 dkim, 4 dmarc, 8 mx
  bl: number;             // blocklist listings count
  open: string[];         // cause codes open at observation
  wear: number;           // wear score that day (0-100)
  health: number;         // composite health 0-100
}

/** Packed mailbox day: [d, rep, wSent, wSpam, cSent, bounced, statusCode, blockingCount] */
export type MailboxDay = [string, number | null, number, number, number, number, number, number];

export const MAILBOX_DAY_FIELDS = ["d", "rep", "wSent", "wSpam", "cSent", "bounced", "status", "blockers"] as const;
export const MAILBOX_STATUS_CODES = ["unknown", "active", "warming", "paused", "error", "held"] as const;

export interface ShelfLife {
  /** Where it is in its life. */
  stage: "provisioning" | "warming" | "ready" | "prime" | "fatigued" | "burned" | "retired";
  /** 0 = brand new, 100 = spent. */
  wearPct: number;
  /** Why it is worn, itemised, so the number is never a black box. */
  contributions: Array<{ label: string; points: number; detail: string }>;
  ageDays: number | null;
  lifetimeSent: number;
  lifetimeBounced: number;
  bounceRatePct: number | null;
  /** Wear points added per day, averaged over the recorded window. */
  wearPerDay: number | null;
  /** Projected days until wear reaches 100 at the current rate. Null = not enough history, or not wearing. */
  daysRemaining: number | null;
  /** Projected calendar date of retirement at the current rate. */
  retireBy: string | null;
  /** Sends it is projected to carry before retirement, at its current daily rate. */
  sendsRemaining: number | null;
  /** Plain-English summary an operator can act on. */
  verdict: string;
}
