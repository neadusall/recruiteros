/**
 * RecruitersOS · Owner · Where each vendor's receipt actually comes from (OWNER ONLY)
 *
 * The Spend master can only report a month honestly if a real receipt for that month
 * exists. Almost none of these vendors expose a billing API — the ones that do are noted
 * below — so the universal channel is the one every vendor already uses: they EMAIL the
 * receipt. This table is the map that turns those emails into ledger rows:
 *
 *   from      the addresses/domains the receipt actually arrives from (matcher input)
 *   subject   phrases that mark a billing message rather than product mail
 *   merchant  how the merchant name appears when the receipt is sent by a payment
 *             processor (Stripe/Paddle/PayPal) instead of the vendor itself
 *   portal    where to download an invoice by hand when email failed (the backfill path)
 *   billingDay  when in the month the charge lands, so a missing receipt can be called
 *             missing at the right time instead of on the 1st
 *   api       whether a programmatic invoice pull exists at all
 *
 * Kept separate from the harvester so the console can SHOW this table: "here is how each
 * vendor reports, here is which ones are wired, here is the one you still have to point
 * at the billing mailbox". That list is what stops a month from going unreported.
 */

export type ReceiptChannel =
  /** The vendor emails a receipt directly. */
  | "email_vendor"
  /** A payment processor emails the receipt on the vendor's behalf. */
  | "email_processor"
  /** No email is sent at all: the invoice must be downloaded from the portal. */
  | "portal_only"
  /** A real invoice API exists and could be pulled without email. */
  | "api";

export interface VendorSource {
  /** Matches SpendItem.vendor (case-insensitive). */
  vendor: string;
  channel: ReceiptChannel;
  /** Sender addresses or domains, lowercase. A domain matches any address on it. */
  from: string[];
  /** Lowercase phrases; any hit marks the message as billing. */
  subject: string[];
  /** How the merchant names itself inside a processor receipt body. */
  merchant?: string[];
  /** Where to download invoices by hand. */
  portal?: string;
  /** Day of month the charge typically posts (1-28), for missing-receipt timing. */
  billingDay?: number;
  /** Programmatic invoice access, when it exists. */
  api?: string;
  /** What the owner has to do once, in their own words, to make this vendor report. */
  setup?: string;
}

/**
 * The processors. Their receipts name the merchant in the subject or the first lines of
 * the body ("Receipt from Serper"), so the merchant string is what identifies the vendor,
 * not the sender.
 */
export const PROCESSOR_DOMAINS = ["stripe.com", "paddle.com", "paypal.com", "chargebee.com", "recurly.com", "2checkout.com", "fastspring.com", "lemonsqueezy.com"];

export const VENDOR_SOURCES: VendorSource[] = [
  {
    vendor: "RapidAPI",
    channel: "email_vendor",
    from: ["rapidapi.com", "billing@rapidapi.com", "noreply@rapidapi.com"],
    subject: ["rapidapi", "receipt", "invoice", "payment", "subscription"],
    portal: "https://rapidapi.com/developer/billing/invoices-and-receipts",
    billingDay: 1,
    setup: "RapidAPI emails one receipt covering ALL five subscriptions on one invoice. The harvester splits it back out per listing when the body names them; when it cannot, the whole charge lands on one row and the console flags it for a manual split.",
  },
  {
    vendor: "Anthropic",
    channel: "email_processor",
    from: ["anthropic.com", "stripe.com"],
    subject: ["anthropic", "receipt", "invoice", "credits"],
    merchant: ["anthropic"],
    portal: "https://console.anthropic.com/settings/billing",
    api: "No public billing API. Console -> Billing -> Invoices exports PDF.",
    setup: "Prepaid credit top-ups, so the charge is irregular. Add the billing mailbox under Console -> Settings -> Billing contacts.",
  },
  {
    vendor: "Telnyx",
    channel: "portal_only",
    from: ["telnyx.com", "billing@telnyx.com", "noreply@telnyx.com"],
    subject: ["telnyx", "invoice", "receipt", "payment", "auto-recharge", "balance"],
    portal: "https://portal.telnyx.com/#/billing/history",
    billingDay: 1,
    api: "PARTLY. GET /v2/usage_reports prices USAGE per month, and that is pulled automatically as consumption. It is NOT the bill: its product list has no phone-number rental and no 10DLC line, so it prices traffic only (Lume's July: ~$13 of usage against $105 actually paid in). GET /v2/invoices states a period and a paid flag with no total and no PDF. Payment History is not in the API in any form.",
    setup: "PREPAID: the account carries a balance and the money leaves when it is topped up, so the receipts that matter are the payment receipts under Billing > Payment History, each with its own Download. The portal puller collects them. Note there are TWO accounts, the house one and Lume's, with separate logins and separate balances.",
  },
  {
    vendor: "Hetzner",
    channel: "email_vendor",
    from: ["hetzner.com", "hetzner.de", "accounting@hetzner.com", "no-reply@hetzner.com"],
    subject: ["hetzner", "invoice", "rechnung", "cloud"],
    portal: "https://accounts.hetzner.com/invoice",
    billingDay: 1,
    api: "Hetzner Cloud API has no invoice endpoint (the Robot API does, for dedicated servers only).",
    setup: "One invoice covers every box on the project, so the console splits it across the app server, the worker and the scraper fleet by their share of the register.",
  },
  {
    vendor: "RackNerd",
    channel: "email_vendor",
    from: ["racknerd.com", "billing@racknerd.com", "noreply@racknerd.com"],
    subject: ["racknerd", "invoice", "payment", "receipt", "renewal"],
    portal: "https://my.racknerd.com/clientarea.php?action=invoices",
    setup: "WHMCS sends an invoice AND a payment confirmation for the same charge; the harvester counts the payment, not the invoice, so the month is never double-billed.",
  },
  {
    vendor: "ElevenLabs",
    channel: "email_processor",
    from: ["elevenlabs.io", "stripe.com"],
    subject: ["elevenlabs", "receipt", "invoice", "subscription"],
    merchant: ["elevenlabs", "eleven labs"],
    portal: "https://elevenlabs.io/app/settings/billing",
    billingDay: 1,
  },
  {
    vendor: "Hume",
    channel: "email_processor",
    from: ["hume.ai", "stripe.com"],
    subject: ["hume", "receipt", "invoice"],
    merchant: ["hume ai", "hume"],
    portal: "https://platform.hume.ai/settings/billing",
  },
  {
    vendor: "Serper.dev",
    channel: "email_processor",
    from: ["serper.dev", "stripe.com"],
    subject: ["serper", "receipt", "credits"],
    merchant: ["serper"],
    portal: "https://serper.dev/dashboard",
    setup: "Credit top-ups, not a subscription: a month with no receipt means no top-up was needed, which the console reports as such rather than as a missing receipt.",
  },
  {
    vendor: "Reoon",
    channel: "email_vendor",
    from: ["reoon.com", "emailverifier.reoon.com"],
    subject: ["reoon", "receipt", "invoice", "credits", "payment"],
    portal: "https://emailverifier.reoon.com/dashboard",
    setup: "Lifetime licence, bought outright years ago: there is no subscription and no monthly charge, so no recurring receipt exists to chase. The matcher stays armed anyway, so the first credit top-up receipt is captured the moment volume makes one necessary.",
  },
  {
    vendor: "KoldInfo",
    channel: "email_vendor",
    from: ["koldinfo.com"],
    subject: ["koldinfo", "receipt", "invoice", "subscription", "payment"],
    portal: "https://koldinfo.com/dashboard",
  },
  {
    vendor: "Laxis",
    channel: "email_processor",
    from: ["laxis.com", "stripe.com"],
    subject: ["laxis", "receipt", "invoice", "subscription"],
    merchant: ["laxis"],
    portal: "https://app.laxis.com/settings/billing",
  },
  {
    vendor: "Smartlead",
    channel: "email_processor",
    from: ["smartlead.ai", "stripe.com"],
    subject: ["smartlead", "receipt", "invoice", "subscription"],
    merchant: ["smartlead"],
    portal: "https://app.smartlead.ai/app/settings/billing",
  },
  {
    vendor: "Resend",
    channel: "email_processor",
    from: ["resend.com", "stripe.com"],
    subject: ["resend", "receipt", "invoice"],
    merchant: ["resend"],
    portal: "https://resend.com/settings/billing",
  },
  {
    vendor: "Unipile",
    channel: "email_processor",
    from: ["unipile.com", "stripe.com"],
    subject: ["unipile", "receipt", "invoice", "subscription"],
    merchant: ["unipile"],
    portal: "https://dashboard.unipile.com/billing",
  },
  {
    vendor: "Loxo",
    channel: "email_vendor",
    from: ["loxo.co", "billing@loxo.co"],
    subject: ["loxo", "invoice", "receipt", "payment"],
    portal: "https://app.loxo.co/settings/billing",
    setup: "Annual or per-seat contract billing: the invoice may arrive from a person rather than a billing robot, so keep the sender's address on the allow-list once you see the first one.",
  },
  {
    vendor: "Adzuna",
    channel: "portal_only",
    from: ["adzuna.com"],
    subject: ["adzuna", "invoice"],
    portal: "https://developer.adzuna.com/admin/access",
    setup: "Free tier: no invoice exists. The console reports it as free rather than missing.",
  },
  {
    vendor: "Dynadot",
    channel: "email_vendor",
    from: ["dynadot.com", "billing@dynadot.com"],
    subject: ["dynadot", "order", "renewal", "receipt", "invoice", "domain"],
    portal: "https://www.dynadot.com/account/domain/order/history.html",
    setup: "Domain renewals. One order confirmation can cover several domains; the console attributes it to the domains named in the body.",
  },
  {
    vendor: "Namecheap",
    channel: "email_vendor",
    from: ["namecheap.com"],
    subject: ["namecheap", "order", "renewal", "receipt", "invoice", "domain"],
    portal: "https://ap.www.namecheap.com/billing/orderhistory",
  },
  {
    vendor: "Cloudflare",
    channel: "email_vendor",
    from: ["cloudflare.com"],
    subject: ["cloudflare", "invoice", "receipt", "registrar", "renewal"],
    portal: "https://dash.cloudflare.com/?to=/:account/billing",
  },
  {
    vendor: "GoDaddy",
    channel: "email_vendor",
    from: ["godaddy.com", "secureserver.net"],
    subject: ["godaddy", "receipt", "renewal", "order"],
    portal: "https://account.godaddy.com/billing",
  },
  {
    vendor: "Object storage",
    channel: "email_vendor",
    from: ["hetzner.com", "amazonaws.com", "aws.amazon.com", "backblaze.com", "wasabi.com"],
    subject: ["storage", "invoice", "bill", "s3"],
    setup: "Metered storage: the monthly bill arrives with the provider's other charges, so it may already be inside the Hetzner or AWS invoice rather than on its own.",
  },

  /* ---- the rest of the account catalogue -------------------------------------------
   * Every remaining service the platform runs on, so each one can say where its receipt
   * comes from instead of reading as an unexplained blank. Sender domains are the ones
   * these vendors actually mail from; where a vendor bills through Stripe the merchant
   * name is what identifies it, because the sender will be Stripe. */
  {
    vendor: "Sending.ac",
    channel: "email_processor",
    from: ["sending.ac", "sso.ac", "stripe.com"],
    subject: ["sending", "mailbox", "receipt", "invoice", "subscription"],
    merchant: ["sending.ac", "sending ac", "mailbox slot"],
    portal: "https://sso.ac/",
    billingDay: 24,
    setup: "Billed per mailbox slot through Stripe, so the sender is Stripe and the merchant name identifies it. The 24th is the anniversary: the one invoice on record is $599.00 of 2026-06-24 and the next period the billing page names runs 2026-08-24 to 2026-09-24. Sign in through sso.ac, open the Stripe billing portal from there, and take the invoice out of Invoice history.",
  },
  {
    vendor: "Zapmail",
    channel: "email_processor",
    from: ["zapmail.ai", "stripe.com"],
    subject: ["zapmail", "mailbox", "receipt", "invoice", "subscription", "domain"],
    merchant: ["zapmail"],
    portal: "https://app.zapmail.ai/billing",
    api: "POST /v2/payment/invoices (header x-auth-zapmail) returns a Stripe invoice URL, but only for a subscription id it does not itself hand out, and it carries no amount. So it can fetch the document once the subscription is known and can never state the figure.",
    setup: "Two charges live here, not one: the Google Workspace mailboxes monthly, and the domains Zapmail registered on their reseller registrar. Both bill through Stripe, so the sender is Stripe and the merchant name is what identifies them.",
  },
  {
    vendor: "Microsoft 365",
    channel: "email_vendor",
    from: ["microsoft.com", "microsoftonline.com", "billing.microsoft.com"],
    subject: ["microsoft", "invoice", "billing statement", "subscription"],
    portal: "https://admin.microsoft.com/#/billoverview/invoice-list",
    setup: "Invoices sit in the Microsoft 365 admin centre under Billing. Microsoft emails a notice rather than the PDF, so the portal is the reliable route.",
  },
  {
    vendor: "Instantly",
    channel: "email_processor",
    from: ["instantly.ai", "stripe.com"],
    subject: ["instantly", "receipt", "invoice", "subscription"],
    merchant: ["instantly"],
    portal: "https://app.instantly.ai/app/settings/billing",
  },
  {
    vendor: "Mailcow",
    channel: "portal_only",
    from: [],
    subject: [],
    setup: "Open source and self-hosted: no licence, no invoice, nothing to collect. The cost is the RackNerd box it runs on.",
  },
  {
    vendor: "Vercel",
    channel: "email_vendor",
    from: ["vercel.com"],
    subject: ["vercel", "invoice", "receipt", "payment"],
    portal: "https://vercel.com/account/invoices",
  },
  {
    vendor: "GitHub",
    channel: "email_vendor",
    from: ["github.com"],
    subject: ["github", "receipt", "payment", "invoice"],
    portal: "https://github.com/settings/billing",
    setup: "Nothing arrives if the account is on the free plan, which is the likely answer here. Confirm once and price the row at zero.",
  },
  {
    vendor: "Cloudflare",
    channel: "email_vendor",
    from: ["cloudflare.com"],
    subject: ["cloudflare", "invoice", "receipt", "payment"],
    portal: "https://dash.cloudflare.com/?to=/:account/billing",
  },
  {
    vendor: "Porkbun",
    channel: "email_vendor",
    from: ["porkbun.com"],
    subject: ["porkbun", "order", "receipt", "renewal", "invoice"],
    portal: "https://porkbun.com/account/billing",
    setup: "Domains bill one at a time, so receipts arrive per name rather than monthly.",
  },
  {
    vendor: "GoDaddy",
    channel: "email_vendor",
    from: ["godaddy.com", "secureserver.net"],
    subject: ["godaddy", "receipt", "renewal", "order", "invoice"],
    portal: "https://account.godaddy.com/billing/payment-history",
  },
  {
    vendor: "LinkedIn",
    channel: "email_vendor",
    from: ["linkedin.com"],
    subject: ["linkedin", "sales navigator", "receipt", "invoice", "subscription"],
    portal: "https://www.linkedin.com/premium/my-premium/",
    setup: "Sales Navigator receipts are emailed to the account holder and kept under Premium settings, not in a billing portal of their own.",
  },
  {
    vendor: "Apify",
    channel: "email_processor",
    from: ["apify.com", "stripe.com"],
    subject: ["apify", "receipt", "invoice", "subscription"],
    merchant: ["apify"],
    portal: "https://console.apify.com/billing",
  },
  {
    vendor: "Icypeas",
    channel: "email_processor",
    from: ["icypeas.com", "stripe.com"],
    subject: ["icypeas", "receipt", "invoice", "subscription"],
    merchant: ["icypeas"],
    portal: "https://app.icypeas.com/",
  },
  {
    vendor: "People Data Labs",
    channel: "email_processor",
    from: ["peopledatalabs.com", "stripe.com"],
    subject: ["people data labs", "pdl", "receipt", "invoice"],
    merchant: ["people data labs"],
    portal: "https://dashboard.peopledatalabs.com/billing",
  },
  {
    vendor: "Cartesia",
    channel: "email_processor",
    from: ["cartesia.ai", "stripe.com"],
    subject: ["cartesia", "receipt", "invoice", "subscription"],
    merchant: ["cartesia"],
    portal: "https://play.cartesia.ai/",
  },
];

/* RETIRED BY THE OWNER, 2026-08-03: AWS and TidyCal are not costs of this business.
 * Both were already on SEED_RETIREMENTS so their register rows had gone, but leaving them
 * HERE would have kept collecting them: `relevanceOf` treats any catalogued vendor as
 * ours, so every sweep re-filed the receipts the owner had just deleted. A vendor is
 * retired in two places or it is not retired at all.
 * AWS also carried the worst of the substring collisions ("aws" sits inside draws, laws
 * and flaws), which is what filed a $50,000 marketing email as an infrastructure bill.
 * Their mail streams were also the worst of the junk: amazon.com is Amazon RETAIL (Prime
 * Day blasts, shipped-order notices, a $10,000 grocery sweepstake all filed as AWS), and
 * appsumo.com is a MARKETPLACE mailing daily deals for hundreds of products (all filed as
 * TidyCal, one for $2.7M — a revenue brag in a marketing subject line). If either vendor
 * ever comes back, list only their own billing domains, never the marketplace's. */

/** Generic billing signals used when no vendor rule matches: still catch the charge.
 *  ⚠️ Weak corroboration ONLY — never enough to file on its own. "billing", "paid" and
 *  "renewal notice" used to live here and each one filed marketing ("Multi-tenant billing
 *  portal", "prepaid", GoDaddy renewal REMINDERS) as money spent. */
export const GENERIC_SUBJECT_HINTS = [
  "receipt", "invoice", "payment received", "payment confirmation", "thanks for your payment",
  "thank you for your payment", "your payment", "subscription renewed",
  "order confirmation", "auto-recharge", "credit purchase",
];

/** Messages that LOOK like billing but are not a charge. Excluded, and counted as excluded. */
export const NON_CHARGE_HINTS = [
  "payment failed", "payment declined", "card declined", "action required to keep",
  "your trial", "trial ending", "upgrade to", "invoice is due", "past due", "unpaid invoice",
  "reminder: invoice", "estimate", "quote",
  /* A renewal NOTICE quotes the price of a charge that has not happened yet; filing it
     invents the charge, sometimes years in the future (the domain's expiry date parses as
     the period). Same for a failed payment, an expiry warning, a security notice, a support
     ticket and a 3-D Secure prompt: money is named, none of it moved. */
  "renewal notice", "was unsuccessful", "payment unsuccessful", "expires soon",
  "expiring soon", "new sign-in", "sign-in detected", "verification reminder",
  "rate limit", "[ticket",
];

/**
 * A subject line that STATES this is a record of money that moved. This is the strong
 * signal the classifier files on: every real vendor receipt in the vault matches one of
 * these ("Your receipt from…", "Invoice 086000951457", "Order Received (order …)",
 * "Credit Card Payment Confirmation", "[Telnyx LLC] Payment Success", "Order - Thank You").
 * A vendor's name in the subject is deliberately NOT here: every mail a vendor sends has
 * its name on it, which is how job alerts became LinkedIn charges and product news became
 * Hetzner spend.
 */
export const RECEIPT_SUBJECT_RE =
  /\breceipt\b|\binvoice\s*#?\s*\d|\b(?:your|new) invoice\b|\border\s+(?:confirmation|received|summary|finished|completed?)\b|\border\b.{0,12}\bthank you\b|\bthank you\b.{0,16}\border\b|\bthank you for (?:your )?purchas/i;

/** More payment-shaped subjects, kept apart only for readability. */
export const PAYMENT_SUBJECT_RE =
  /\bpayment\s+(?:confirmation|received|success(?:ful)?|processed)\b|\bthank you for your payment\b|\bauto.?recharge\b|\bbilling statement\b|\brenewal confirmation\b|\bhas been renewed\b|\bcredit purchase\b/i;

/**
 * Subjects that carry a billing word and still are not a payment: an invoice being
 * GENERATED (WHMCS mails "Invoice #N Generated" and "Customer Invoice" before the payment
 * confirmation for the same charge — counting both double-bills the month, and counting an
 * unpaid invoice books money that may never move), and an invoice merely being ISSUED
 * ("New invoice from X" arrives minutes before "Your receipt from X" for the same charge).
 */
export const NOT_A_PAYMENT_SUBJECT_RE =
  /invoice\s*#?\s*\d+\s+generated\b|\bcustomer invoice\b|\bnew invoice from\b|racknerd - order\s+\d/i;

/**
 * Body phrases that state a completed charge. Deliberately NOT bare "receipt"/"invoice":
 * a marketing email about an invoicing product contains the word "invoice" and no charge.
 */
export const STRONG_BODY_RE =
  /amount paid|total paid|payment received|you paid|amount charged|order total|grand total|subtotal|payment of\s*(?:us)?[$€£]\s?\d[\d,.]*\s*(?:was|is)?\s*successful|successfully (?:paid|charged|processed)|thank you for your (?:order|purchase|payment)/i;

export function vendorSourceFor(vendor: string): VendorSource | undefined {
  const v = (vendor || "").trim().toLowerCase();
  return VENDOR_SOURCES.find((s) => s.vendor.toLowerCase() === v);
}
