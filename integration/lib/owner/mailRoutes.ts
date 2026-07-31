/**
 * RecruitersOS · Owner · Which mailbox holds which vendor's receipts (OWNER ONLY)
 *
 * The harvester can only collect a vendor's receipt if that receipt lands in a mailbox
 * it is allowed to open. Until now nothing in the platform knew where any vendor sends
 * its mail, so a vendor billing an address nobody reads looked exactly like a vendor
 * that had not charged anything — and both looked exactly like a vendor whose password
 * had lapsed. Three very different problems, one blank cell.
 *
 * The Passwords vault already holds one account per vendor. Give each of those accounts
 * the address the vendor bills (`billingEmail`), and this module joins the three lists
 * that were never joined:
 *
 *     vault account  ->  the address the vendor sends receipts to
 *     billingMailboxes()  ->  the addresses this platform can actually open
 *     the receipt vault  ->  which vendors have in fact produced an email receipt
 *
 * and turns them into one line per vendor saying whether that vendor's receipts are
 * reachable, and if not, the single thing to do about it.
 *
 * ── Evidence outranks configuration ─────────────────────────────────────────────
 * A vendor may bill an address that FORWARDS into a mailbox being read, and nothing in
 * any config can know that. So a vendor whose receipts have actually arrived is reported
 * as collecting, whatever the addresses say — an observed receipt settles the question
 * that a configured address can only guess at. Configuration is the fallback, used to
 * predict the vendors that have not been heard from yet.
 *
 * ── What is deliberately NOT a gap ──────────────────────────────────────────────
 * Some vendors email no document at all: Telnyx issues none, Mailcow is self-hosted and
 * bills nothing, Adzuna is a free tier. Reporting those as missing mail would bury the
 * handful of real gaps under a list of vendors behaving exactly as expected, so they are
 * reported as collected another way, or as nothing to collect.
 */

import type { SafeEntry } from "./vault";
import type { MailboxCfg } from "./receipts";
import { VENDOR_SOURCES, vendorSourceFor, type ReceiptChannel } from "./receiptSources";

export type RouteStatus =
  /** Receipts from this vendor have really arrived by email. Proved, not predicted. */
  | "collecting"
  /** Its billing address is a mailbox being swept, but nothing has come through yet. */
  | "covered"
  /** An address is on file, but it is not one of the mailboxes being read. */
  | "unswept"
  /** Nobody has said which address this vendor bills. */
  | "no_email"
  /** No mailbox is configured at all, so no vendor can be collected from email. */
  | "no_mailbox"
  /** This vendor emails no document; it is collected another way, or there is none. */
  | "not_emailed";

export interface VendorRoute {
  vendor: string;
  /** The vault account this came from, so the console can link straight to the row. */
  accountId?: string;
  service?: string;
  /** The address the vendor bills. */
  email?: string;
  /** Whether that address was stated or fallen back to from the sign-in username. */
  emailFrom?: "billing_email" | "username";
  /** The mailbox that receives it, when one does. */
  mailbox?: string;
  /** How the mailbox was matched, in words. */
  matchedBy?: string;
  status: RouteStatus;
  channel?: ReceiptChannel;
  /** Receipts already collected from email for this vendor. */
  emailReceipts: number;
  /** The most recent one, so a vendor that stopped reporting is visible. */
  lastEmailAt?: string;
  /** The one thing to do about this line. Absent when there is nothing to do. */
  fix?: string;
}

export interface RoutingReport {
  mailboxes: Array<{ user: string; inherited?: boolean; vendors: number }>;
  routes: VendorRoute[];
  /** Vendors whose receipts are reachable now (collecting or covered). */
  reachable: number;
  /** Vendors that could email a receipt but whose mail nobody is reading. */
  unreachable: number;
  /** Vendors nobody has given an address for: the owner's worklist. */
  needEmail: number;
}

/* ============================ addresses ============================ */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmail(s: string | undefined): boolean {
  return !!s && EMAIL.test(s.trim());
}

/**
 * The address a vendor bills, and where that answer came from.
 *
 * `username` is used only when it IS an email. Several accounts here sign in with
 * something else entirely (RackNerd's client area is `vmuser346309`, AWS root is an
 * account number), and turning one of those into an address would put a confident wrong
 * answer where an honest blank belongs.
 */
export function receiptEmailFor(e: Pick<SafeEntry, "billingEmail" | "username">): { email: string; from: "billing_email" | "username" } | null {
  const stated = (e.billingEmail || "").trim().toLowerCase();
  if (isEmail(stated)) return { email: stated, from: "billing_email" };
  const user = (e.username || "").trim().toLowerCase();
  if (isEmail(user)) return { email: user, from: "username" };
  return null;
}

/** `ryan+aws@lumesp.com` and `ryan.nead@gmail.com` both land in the same mailbox. */
function canonical(addr: string): { local: string; domain: string } {
  const [rawLocal = "", domain = ""] = addr.trim().toLowerCase().split("@");
  let local = rawLocal.split("+")[0];
  // Gmail ignores dots in the local part; other providers do not, so this is Gmail-only.
  if (domain === "gmail.com" || domain === "googlemail.com") local = local.replace(/\./g, "");
  return { local, domain };
}

/**
 * Does this mailbox receive that address?
 *
 * Only sub-addressing is treated as the same mailbox, because it provably is: a plus tag
 * is chosen by the sender's own account holder and always delivers to the base address.
 * Anything else — a forward, a distribution list, a catch-all — is real and common but
 * cannot be known from the address, so it is left to be settled by evidence instead of
 * assumed here. Assuming it would report a vendor as covered when its receipts go
 * somewhere nobody reads.
 */
export function mailboxCovers(mailbox: string, address: string): { covered: boolean; how?: string } {
  if (!isEmail(mailbox) || !isEmail(address)) return { covered: false };
  const m = canonical(mailbox);
  const a = canonical(address);
  if (m.domain !== a.domain) return { covered: false };
  if (m.local === a.local) {
    const same = mailbox.trim().toLowerCase() === address.trim().toLowerCase();
    return { covered: true, how: same ? "this mailbox is the billing address" : "the same mailbox, sub-addressed" };
  }
  return { covered: false };
}

/* ============================ the report ============================ */

export interface RoutingInput {
  entries: SafeEntry[];
  mailboxes: MailboxCfg[];
  /** Only what this needs from a Receipt, so the report can be built from a fixture. */
  receipts: Array<{ vendor: string; source?: string; mailbox?: string; chargedAt?: string }>;
}

/** A vendor that emails nothing is not a gap; say which of the two reasons applies. */
function nothingToCollect(channel: ReceiptChannel | undefined, vendor: string): string | undefined {
  if (channel !== "portal_only") return undefined;
  const src = vendorSourceFor(vendor);
  return src?.setup || "This vendor emails no document; it is collected from its portal instead.";
}

/**
 * One line per vendor: is its receipt reachable, and if not, what is the single next step.
 *
 * Built from the vault rather than from the register on purpose. The register is a list
 * of money and can hold several rows for one vendor; the vault is a list of ACCOUNTS,
 * and an account is what has a mailbox behind it. Vendors with several accounts (two
 * Telnyx, three RackNerd) fold to one line here, because they all mail the same place.
 */
export function receiptRouting(input: RoutingInput): RoutingReport {
  const { entries, mailboxes, receipts } = input;

  /* Evidence first: what has actually arrived, per vendor. */
  const seen = new Map<string, { count: number; last?: string; mailbox?: string }>();
  for (const r of receipts) {
    if (r.source !== "email") continue;
    const key = (r.vendor || "").trim().toLowerCase();
    if (!key) continue;
    const prev = seen.get(key) || { count: 0 };
    prev.count += 1;
    if (!prev.last || (r.chargedAt || "") > prev.last) { prev.last = r.chargedAt; prev.mailbox = r.mailbox; }
    seen.set(key, prev);
  }

  /* One line per VENDOR. An entry with no vendor still counts under its own service
     name: an uncatalogued account that bills something is exactly what this should
     surface, not swallow. */
  const byVendor = new Map<string, SafeEntry[]>();
  for (const e of entries) {
    const key = (e.vendor || e.service || "").trim();
    if (!key) continue;
    const list = byVendor.get(key) || [];
    list.push(e);
    byVendor.set(key, list);
  }
  /* A vendor the receipt table knows about but the vault does not is still reported,
     because its receipts are being matched against a sender nobody has an account for. */
  for (const s of VENDOR_SOURCES) {
    if (![...byVendor.keys()].some((k) => k.toLowerCase() === s.vendor.toLowerCase())) byVendor.set(s.vendor, []);
  }

  const perMailbox = new Map<string, number>();
  const routes: VendorRoute[] = [];

  for (const [vendor, accounts] of byVendor) {
    const src = vendorSourceFor(vendor);
    const evidence = seen.get(vendor.toLowerCase());
    /* Prefer the account that states an address over one that only has a sign-in name,
       so a vendor with three logins reports the answer somebody actually filled in. */
    const withEmail = accounts
      .map((a) => ({ a, r: receiptEmailFor(a) }))
      .filter((x) => !!x.r)
      .sort((x, y) => (x.r!.from === "billing_email" ? -1 : 1) - (y.r!.from === "billing_email" ? -1 : 1));
    const pick = withEmail[0];
    const account = pick?.a || accounts[0];
    const resolved = pick?.r;

    const route: VendorRoute = {
      vendor,
      accountId: account?.id,
      service: account?.service,
      email: resolved?.email,
      emailFrom: resolved?.from,
      status: "no_email",
      channel: src?.channel,
      emailReceipts: evidence?.count || 0,
      lastEmailAt: evidence?.last,
    };

    const match = resolved
      ? mailboxes.map((m) => ({ m, c: mailboxCovers(m.user, resolved.email) })).find((x) => x.c.covered)
      : undefined;
    if (match) {
      route.mailbox = match.m.user;
      route.matchedBy = match.c.how;
    }

    if (evidence?.count) {
      /* Proved. The mailbox it actually arrived in is the truth, whatever is configured,
         which is how a forwarded address settles itself. */
      route.status = "collecting";
      route.mailbox = evidence.mailbox || route.mailbox;
      route.matchedBy = evidence.mailbox && !match ? "receipts arrive here, so the address forwards into it" : route.matchedBy;
    } else if (!mailboxes.length) {
      route.status = "no_mailbox";
      route.fix = "No billing mailbox is configured yet, so no vendor can report by email. Run connect-billing-inbox.ps1 to point one at the platform.";
    } else if (src && nothingToCollect(src.channel, vendor)) {
      route.status = "not_emailed";
      route.fix = nothingToCollect(src.channel, vendor);
    } else if (!resolved) {
      route.status = "no_email";
      route.fix = `Open ${account?.service || vendor} in Passwords and fill in the address this vendor sends receipts to.`;
    } else if (match) {
      route.status = "covered";
    } else {
      route.status = "unswept";
      route.fix = `${resolved.email} is not one of the mailboxes being read. Either add it (connect-billing-inbox.ps1 ${resolved.email}) or change the billing contact at ${src?.portal || account?.url || "the vendor"} to a mailbox that is.`;
    }

    /* The tally is what this mailbox actually BRINGS IN. A vendor that emails no
       document at all still resolves to an address, and counting it here would credit a
       mailbox with receipts that are never going to arrive through it. */
    if (route.mailbox && (route.status === "collecting" || route.status === "covered")) {
      perMailbox.set(route.mailbox, (perMailbox.get(route.mailbox) || 0) + 1);
    }
    routes.push(route);
  }

  const rank: Record<RouteStatus, number> = { no_mailbox: 0, unswept: 1, no_email: 2, covered: 3, collecting: 4, not_emailed: 5 };
  routes.sort((a, b) => rank[a.status] - rank[b.status] || a.vendor.localeCompare(b.vendor));

  return {
    mailboxes: mailboxes.map((m) => ({ user: m.user, inherited: m.inherited, vendors: perMailbox.get(m.user) || 0 })),
    routes,
    reachable: routes.filter((r) => r.status === "collecting" || r.status === "covered").length,
    unreachable: routes.filter((r) => r.status === "unswept" || r.status === "no_mailbox").length,
    needEmail: routes.filter((r) => r.status === "no_email").length,
  };
}
