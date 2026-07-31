/**
 * RecruitersOS · Billing · Receipt coverage (OWNER ONLY)
 *
 * The other half of the spend ledger. The ledger says what we spent; this says
 * whether we hold the vendor's own document proving it, for every provider we
 * pay. An accountant cannot use a number without the receipt behind it, so a
 * provider with no receipt route set up is a hole in the books, and this module
 * exists to make that hole impossible to miss.
 *
 * The fetching itself happens off-platform, in the spend-ledger tool: it tries
 * each provider's own API first and falls back to a browser session against the
 * provider's billing page, on the day of the charge and again through a grace
 * window until the document lands. That tool pushes what it found here.
 *
 * The provider catalog below is deliberately server-side rather than only in
 * the pushing tool. If nothing has ever been pushed, every provider still
 * appears, reported as needing setup, which is the honest state: no receipts
 * are being collected. Silence must never look like success.
 *
 * In-memory reference store + debounced snapshot, exactly like the ledger.
 */

import { nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

/** How a provider's receipt is obtained, cheapest reliable route first. */
export type ReceiptMethod = "api" | "api + portal" | "portal";

/** Where a provider stands right now. Ordered worst to best for sorting. */
export type ReceiptState =
  | "setup-needed"  // nothing can fetch this yet: the browser session is not signed in
  | "error"         // the last attempt failed
  | "missing"       // a charge is past its grace window with no document
  | "stale"         // the sweep itself has stopped running
  | "never-run"     // set up, but never actually run
  | "waiting"       // charged recently; the vendor has not published the document yet
  | "no-charges"    // nothing was billed in the period checked
  | "ok";           // every charge has the vendor's own receipt on file

export interface ReceiptProvider {
  id: string;
  name: string;
  category: string;
  /** What we buy from them, in plain words. */
  what: string;
  cadence: "monthly" | "usage";
  /** Day of the month the charge lands. null when it is not known yet. */
  billingDay: number | null;
  /** Days after the charge the vendor may take to publish the document. */
  graceDays: number;
  method: ReceiptMethod;
  /** true = the API returns the document itself; "partial" = numbers only. */
  apiSupported: boolean | "partial";
  apiNote: string;
  invoicesUrl: string;
  active: boolean;
}

export interface ReceiptMiss {
  id: string;
  date: string | null;
  amount: number | null;
  currency?: string;
  reason: string;
}

/** One provider's line as the sweep last reported it. */
export interface ReceiptRun {
  id: string;
  state?: ReceiptState;
  ready?: boolean;
  sessionReady?: boolean;
  apiKeySet?: boolean;
  apiKey?: string | null;
  lastRunAt?: string | null;
  lastRunOn?: string | null;
  charges?: number;
  receipted?: number;
  totalUsd?: number;
  missing?: ReceiptMiss[];
  error?: string | null;
  note?: string | null;
  nextExpected?: string | null;
  skipReason?: string | null;
}

export interface SweepReport {
  generatedAt: string | null;
  host?: string | null;
  providers: ReceiptRun[];
}

/* ---------------- the catalog ---------------- */

/**
 * Every provider the house pays. `apiSupported` records what the provider's own
 * developer documentation said when it was last checked: API first is always
 * preferred, and AWS is the only one on this list that hands over the document
 * itself over an API.
 */
export const RECEIPT_PROVIDERS: ReceiptProvider[] = [
  {
    id: "rapidapi", name: "RapidAPI", category: "data-apis",
    what: "JSearch, skip tracing, LinkedIn data",
    cadence: "usage", billingDay: 1, graceDays: 2,
    method: "portal", apiSupported: false,
    apiNote: "The Hub API is for API publishers, not consumer billing. Plan headroom is readable from response headers; transactions and receipts are portal only.",
    invoicesUrl: "https://rapidapi.com/console/11981388/billing/transactions", active: true,
  },
  {
    id: "smartlead", name: "Smartlead", category: "email-warmup",
    what: "Warm-up sending infrastructure",
    cadence: "monthly", billingDay: 27, graceDays: 3,
    method: "portal", apiSupported: false,
    apiNote: "Their API covers campaigns and mailboxes. Billing runs through Stripe on Smartlead's own account, so the customer route is the Stripe billing portal.",
    invoicesUrl: "https://app.smartlead.ai/app/settings/billing", active: true,
  },
  {
    id: "telnyx", name: "Telnyx", category: "telephony",
    what: "OS Text SMS, BD Phone voice, number lookups, vetting minutes",
    cadence: "monthly", billingDay: 1, graceDays: 3,
    method: "portal", apiSupported: false,
    apiNote: "Telnyx v2 exposes GET /v2/balance only. No invoices or statements endpoint, so the balance is readable but the invoice PDFs are portal only.",
    invoicesUrl: "https://portal.telnyx.com/#/app/billing/invoices", active: true,
  },
  {
    id: "anthropic", name: "Anthropic", category: "llm",
    what: "Personalisation, reply classification, vetting, AI call notes",
    cadence: "usage", billingDay: 1, graceDays: 3,
    method: "api + portal", apiSupported: "partial",
    apiNote: "The Admin API cost report returns authoritative daily spend with an admin key, so the amount is never scraped. It returns no document, so the invoice still comes from the console.",
    invoicesUrl: "https://console.anthropic.com/settings/billing", active: true,
  },
  {
    id: "hetzner", name: "Hetzner", category: "infrastructure",
    what: "App servers, scraper fleet, video workers, object storage, DNS",
    cadence: "monthly", billingDay: 1, graceDays: 4,
    method: "portal", apiSupported: false,
    apiNote: "The Cloud API manages resources only. Invoices live in the accounts area with no API behind them.",
    invoicesUrl: "https://accounts.hetzner.com/invoice", active: true,
  },
  {
    id: "racknerd", name: "RackNerd", category: "infrastructure",
    what: "Mailcow mail server and the validation nodes",
    cadence: "monthly", billingDay: null, graceDays: 4,
    method: "portal", apiSupported: false,
    apiNote: "Billed through WHMCS, whose API is admin-side and not exposed to clients. The client area is the only route.",
    invoicesUrl: "https://my.racknerd.com/clientarea.php?action=invoices", active: true,
  },
  {
    id: "elevenlabs", name: "ElevenLabs", category: "voice",
    what: "Vetting agent voice and personalised video voice",
    cadence: "monthly", billingDay: null, graceDays: 3,
    method: "api + portal", apiSupported: "partial",
    apiNote: "The subscription endpoint returns the renewal date and the amount due, which pins when to look. The invoice history itself is on the billing page.",
    invoicesUrl: "https://elevenlabs.io/app/settings/billing", active: true,
  },
  {
    id: "dynadot", name: "Dynadot", category: "domains",
    what: "Sending domains and lookalike domains",
    cadence: "usage", billingDay: null, graceDays: 3,
    method: "api + portal", apiSupported: "partial",
    apiNote: "The domain API exposes order history and account balance, so orders and amounts need no browser. Receipts are printer-friendly pages in the account area.",
    invoicesUrl: "https://www.dynadot.com/account/domain/order/order-log.html", active: true,
  },
  {
    id: "resend", name: "Resend", category: "email",
    what: "Transactional and portal email, including the Lume relay",
    cadence: "monthly", billingDay: null, graceDays: 3,
    method: "portal", apiSupported: false,
    apiNote: "The API covers sending, domains and audiences. There is no billing endpoint; invoices are in dashboard settings.",
    invoicesUrl: "https://resend.com/settings/billing", active: true,
  },
  {
    id: "apify", name: "Apify", category: "data-apis",
    what: "Direct-dial phone number finder",
    cadence: "monthly", billingDay: null, graceDays: 3,
    method: "api + portal", apiSupported: "partial",
    apiNote: "The platform API returns the plan and current-period usage, which pins the amount and the cycle. There is no invoices endpoint.",
    invoicesUrl: "https://console.apify.com/billing/invoices", active: true,
  },
  {
    id: "serper", name: "Serper", category: "data-apis",
    what: "Search credits behind the JD Sourcing wide pass",
    cadence: "usage", billingDay: null, graceDays: 3,
    method: "portal", apiSupported: false,
    apiNote: "The API is search only. Credit top-ups and their receipts are in the dashboard.",
    invoicesUrl: "https://serper.dev/dashboard", active: true,
  },
  {
    id: "vercel", name: "Vercel", category: "infrastructure",
    what: "Hosting for the GTM OS and Claimie marketing sites",
    cadence: "monthly", billingDay: null, graceDays: 3,
    method: "portal", apiSupported: false,
    apiNote: "Vercel's invoice endpoints belong to the Marketplace API, for partners billing their own customers. There is no customer-facing invoice endpoint.",
    invoicesUrl: "https://vercel.com/account/invoices", active: true,
  },
  {
    id: "unipile", name: "Unipile", category: "linkedin",
    what: "LinkedIn OS connected accounts and messaging",
    cadence: "monthly", billingDay: null, graceDays: 3,
    method: "portal", apiSupported: false,
    apiNote: "The API covers accounts and messaging. Billing is dashboard only.",
    invoicesUrl: "https://dashboard.unipile.com/billing", active: true,
  },
  {
    id: "aws", name: "AWS", category: "infrastructure",
    what: "S3 for the video fleet, if that bucket is billed by AWS",
    cadence: "monthly", billingDay: 3, graceDays: 4,
    method: "api", apiSupported: true,
    apiNote: "The only provider here with a real receipt API: ListInvoiceSummaries returns the invoices and GetInvoicePDF returns a presigned URL to the document. Needs those two IAM permissions.",
    invoicesUrl: "https://us-east-1.console.aws.amazon.com/billing/home#/bills", active: false,
  },
];

/* ---------------- store ---------------- */

const store = { report: null as SweepReport | null };

const SNAP_KEY = "receipt_sweep";
function serialize() {
  return { report: store.report };
}
function hydrate(s: any) {
  if (s?.report) store.report = s.report;
}
const persist = debouncedSaver(SNAP_KEY, serialize);

let hydrated: Promise<void> | null = null;
export function ensureReceiptsReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled() ? loadSnapshot<any>(SNAP_KEY).then(hydrate).catch(() => {}) : Promise.resolve();
  }
  return hydrated;
}
void ensureReceiptsReady();

/** Store what the sweep just reported. Replaces the previous run wholesale. */
export function recordSweep(report: SweepReport): SweepReport {
  store.report = {
    generatedAt: report.generatedAt ?? nowIso(),
    host: report.host ?? null,
    providers: Array.isArray(report.providers) ? report.providers : [],
  };
  persist();
  return store.report;
}

/* ---------------- read ---------------- */

/** A sweep older than this has stopped running, whatever it last reported. */
const STALE_AFTER_DAYS = 3;

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

export interface ReceiptLine extends ReceiptProvider, ReceiptRun {
  /** Resolved state after the server's own staleness check. */
  state: ReceiptState;
  /** What the operator has to do next, or null when nothing is needed. */
  action: string | null;
  daysSinceRun: number | null;
}

export interface ReceiptStatus {
  generatedAt: string | null;
  host: string | null;
  sweepAgeDays: number | null;
  /** True when no sweep has ever reported in. */
  neverSwept: boolean;
  providers: ReceiptLine[];
  totals: {
    tracked: number;
    ready: number;
    setupNeeded: number;
    charges: number;
    receipted: number;
    missing: number;
    coveragePct: number;
    undocumentedUsd: number;
  };
}

const ORDER: ReceiptState[] = [
  "setup-needed", "error", "missing", "stale", "never-run", "waiting", "no-charges", "ok",
];

function actionFor(line: ReceiptProvider & ReceiptRun, state: ReceiptState): string | null {
  switch (state) {
    case "setup-needed":
      return line.apiSupported === true
        ? `Set ${line.apiKey || "the provider's API key"} where the sweep runs, then run: node receipts.mjs pull ${line.id}`
        : `Sign in once so the browser session exists: node receipts.mjs login ${line.id}`;
    case "error":
      return `Last attempt failed. Re-run: node receipts.mjs pull ${line.id}`;
    case "missing":
      return `Past the ${line.graceDays}-day grace window. Pull the document by hand from the provider and file it with: node ledger.mjs confirm`;
    case "stale":
      return "The sweep itself has stopped reporting. Check the scheduled task that runs: node receipts.mjs sweep";
    case "never-run":
      return `Set up but never run. Run: node receipts.mjs pull ${line.id}`;
    default:
      return null;
  }
}

export function receiptStatus(): ReceiptStatus {
  const report = store.report;
  const byId = new Map((report?.providers ?? []).map((p) => [p.id, p]));
  const sweepAgeDays = daysSince(report?.generatedAt);
  const sweepStale = sweepAgeDays != null && sweepAgeDays > STALE_AFTER_DAYS;

  const providers: ReceiptLine[] = RECEIPT_PROVIDERS.filter((p) => p.active).map((p) => {
    const run: ReceiptRun = byId.get(p.id) ?? { id: p.id };
    const daysSinceRun = daysSince(run.lastRunAt);

    // Never pushed, or pushed with nothing behind it: the honest reading is
    // that no receipt is being collected for this provider at all.
    let state: ReceiptState;
    if (!report || run.ready === undefined) state = "setup-needed";
    else if (!run.ready) state = "setup-needed";
    else if (!run.lastRunAt) state = "never-run";
    else if (run.state && run.state !== "ok" && run.state !== "no-charges") state = run.state;
    else if (sweepStale) state = "stale";
    else state = (run.state as ReceiptState) ?? "never-run";

    const line = { ...p, ...run, state, daysSinceRun } as ReceiptLine;
    line.action = actionFor(line, state);
    return line;
  });

  providers.sort((a, b) => {
    const d = ORDER.indexOf(a.state) - ORDER.indexOf(b.state);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });

  const charges = providers.reduce((s, p) => s + (p.charges ?? 0), 0);
  const receipted = providers.reduce((s, p) => s + (p.receipted ?? 0), 0);
  const missing = providers.reduce((s, p) => s + (p.missing?.length ?? 0), 0);
  const undocumentedUsd = providers.reduce(
    (s, p) => s + (p.missing ?? []).reduce((t, m) => t + (Number(m.amount) || 0), 0),
    0,
  );

  return {
    generatedAt: report?.generatedAt ?? null,
    host: report?.host ?? null,
    sweepAgeDays,
    neverSwept: !report,
    providers,
    totals: {
      tracked: providers.length,
      ready: providers.filter((p) => p.ready).length,
      setupNeeded: providers.filter((p) => p.state === "setup-needed").length,
      charges,
      receipted,
      missing,
      coveragePct: charges > 0 ? Math.round((receipted / charges) * 1000) / 10 : 0,
      undocumentedUsd: Math.round(undocumentedUsd * 100) / 100,
    },
  };
}
