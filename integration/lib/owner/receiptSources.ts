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
    channel: "api",
    from: ["telnyx.com", "billing@telnyx.com", "noreply@telnyx.com"],
    subject: ["telnyx", "invoice", "receipt", "payment", "auto-recharge", "balance"],
    portal: "https://portal.telnyx.com/#/billing/history",
    billingDay: 1,
    api: "PULLED AUTOMATICALLY: GET /v2/invoices gives one record per billing month and GET /v2/usage_reports carries a cost metric, so the monthly figure comes straight from Telnyx with no mailbox involved. Neither the invoice total nor a PDF is exposed, and the portal's Payment History (account top-ups) is not in the API at all, so those still come from email or by hand.",
    setup: "Auto-recharge fires whenever the balance drops, so expect several top-up receipts a month on top of the monthly usage figure. All of them count.",
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
    merchant: ["sending.ac", "sending ac"],
    portal: "https://sso.ac/",
    setup: "Billed per mailbox, so the figure moves with the fleet. Sign in through sso.ac and take the invoice from the billing page.",
  },
  {
    vendor: "Zapmail",
    channel: "email_processor",
    from: ["zapmail.ai", "stripe.com"],
    subject: ["zapmail", "mailbox", "receipt", "invoice", "subscription", "domain"],
    merchant: ["zapmail"],
    portal: "https://app.zapmail.ai/billing",
    api: "COLLECTS ITSELF, no sign-in anywhere. GET /v2/subscriptions (header x-auth-zapmail) states the plan, the price and `invoiceDetails`: a Stripe HOSTED INVOICE link, which is its own credential. The sweep reads the whole invoice off it with plain fetch - number, amount, paid date, line items, PDF - so the monthly receipt arrives unattended forever. (The path once recorded here, POST /v2/payment/invoices, does not exist and answers 'Cannot POST'.)",
    setup: "Two kinds of charge live here, not one, and they must not be added together: the Google Workspace mailboxes RECUR at $299/month, while the domains Zapmail registered on its reseller registrar were a ONE-OFF. The monthly one needs nobody. A one-off is not on a subscription, so the API has never heard of it: paste the hosted invoice link out of its receipt email into `node zapmail-invoice.mjs add <url>` once and it collects with the rest from then on.",
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
    vendor: "AWS",
    channel: "email_vendor",
    from: ["amazonaws.com", "aws.amazon.com", "amazon.com"],
    subject: ["aws", "amazon web services", "invoice", "bill", "billing statement"],
    portal: "https://console.aws.amazon.com/billing/home#/bills",
    setup: "AWS emails a monthly notice and keeps the PDF in the billing console. Settle first whether the video bucket is billed here at all.",
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
  {
    vendor: "TidyCal",
    channel: "email_processor",
    from: ["tidycal.com", "appsumo.com", "stripe.com"],
    subject: ["tidycal", "receipt", "invoice", "order"],
    merchant: ["tidycal", "appsumo"],
    portal: "https://tidycal.com/account/billing",
    setup: "Often bought once through AppSumo rather than subscribed. If that is what happened, the receipt is an AppSumo order and the row should be marked Paid once.",
  },
];

/** Generic billing signals used when no vendor rule matches: still catch the charge. */
export const GENERIC_SUBJECT_HINTS = [
  "receipt", "invoice", "payment received", "payment confirmation", "thanks for your payment",
  "thank you for your payment", "your payment", "subscription renewed", "billing", "charged",
  "order confirmation", "renewal notice", "auto-recharge", "credit purchase", "paid",
];

/** Messages that LOOK like billing but are not a charge. Excluded, and counted as excluded. */
export const NON_CHARGE_HINTS = [
  "payment failed", "payment declined", "card declined", "action required to keep",
  "your trial", "trial ending", "upgrade to", "invoice is due", "past due", "unpaid invoice",
  "reminder: invoice", "estimate", "quote",
];

export function vendorSourceFor(vendor: string): VendorSource | undefined {
  const v = (vendor || "").trim().toLowerCase();
  return VENDOR_SOURCES.find((s) => s.vendor.toLowerCase() === v);
}
