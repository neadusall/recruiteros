/**
 * RecruitersOS · Owner · The account catalogue behind the Passwords vault (OWNER ONLY)
 *
 * Every third-party account the platform actually depends on, with the URL you sign in
 * at, which is very often NOT the vendor's marketing domain. Laxis is bought at
 * laxis.com but the product lives at app.laxis.tech; KoldInfo redirects to
 * app.koldinfo.com; Anthropic's console now answers as platform.claude.com; Sending.ac
 * signs in through sso.ac. Guessing "app.<domain>" gets those wrong, so each `url` here
 * was resolved by following the real redirect chain rather than assumed.
 *
 * This table seeds the vault so the tab is useful the moment it opens: the service, the
 * portal, what it is used for, and the account identity where it is already recorded
 * somewhere in this repo. Passwords are never seeded, nothing here is a secret, and
 * nothing here should ever become one. The owner fills those in once, encrypted, in the
 * console.
 *
 * Adding a vendor: put it here, not in the store. The store re-seeds only what is
 * MISSING, so a new row appears on the next load and an edited row is never trampled.
 */

export interface CatalogEntry {
  /** Stable id: also the vault key, so re-seeding never duplicates a row. */
  id: string;
  service: string;
  /** The Spend master line this account pays for, spelled exactly as the register spells
   *  it. One vendor can hold several accounts (three RackNerd, three Dynadot), and this is
   *  what keeps them together and joined to the money. */
  vendor?: string;
  category: CatalogCategory;
  /** Where you actually sign in (resolved, not guessed). */
  url: string;
  /** What breaks if this account is lost. */
  used_for: string;
  /** Account identity already on record in the repo/runbooks. Blank = fill it in. */
  username?: string;
  /** Which account, when there is more than one with the same vendor. */
  account?: string;
  /** Anything that makes signing in or recovering the account non-obvious. */
  notes?: string;
  /** Env var holding the API key, when the platform authenticates with one. */
  envKey?: string;
}

export type CatalogCategory =
  | "Infrastructure"
  | "Domains & DNS"
  | "Email sending"
  | "Telephony & voice"
  | "AI"
  | "Data & sourcing"
  | "Recruiting stack"
  | "Platform";

export const CATALOG_CATEGORIES: CatalogCategory[] = [
  "Infrastructure",
  "Domains & DNS",
  "Email sending",
  "Telephony & voice",
  "AI",
  "Data & sourcing",
  "Recruiting stack",
  "Platform",
];

export const VAULT_CATALOG: CatalogEntry[] = [
  /* ---------------- Infrastructure ---------------- */
  {
    id: "hetzner-cloud",
    service: "Hetzner Cloud",
    vendor: "Hetzner",
    category: "Infrastructure",
    url: "https://console.hetzner.com/",
    used_for: "ros (app server), ros-worker, the scraper fleet, the video workers and object storage",
    notes:
      "console.hetzner.cloud redirects here. Invoices are on a DIFFERENT login at accounts.hetzner.com/invoice, same company, separate account area. Outbound port 25 is blocked on every Hetzner box, which is the whole reason the RackNerd fleet exists.",
    envKey: "HCLOUD_TOKEN",
  },
  {
    id: "hetzner-accounts",
    service: "Hetzner Accounts (billing)",
    vendor: "Hetzner",
    category: "Infrastructure",
    url: "https://accounts.hetzner.com/invoice",
    used_for: "The monthly invoice covering every Hetzner box on the project",
    notes: "No invoice API exists on Hetzner Cloud, so this portal is the only route to the PDF.",
  },
  {
    id: "hetzner-dns",
    service: "Hetzner DNS Console",
    vendor: "Hetzner",
    category: "Domains & DNS",
    url: "https://dns.hetzner.com/",
    used_for: "DNS zones served by Hetzner rather than Cloudflare",
    envKey: "HETZNER_DNS_TOKEN",
  },
  {
    id: "racknerd-billing",
    service: "RackNerd (billing / client area)",
    vendor: "RackNerd",
    category: "Infrastructure",
    url: "https://my.racknerd.com/clientarea.php",
    used_for: "The 8GB Mailcow sending box and the email-validation nodes",
    notes:
      "TWO separate RackNerd accounts: one under Lume Search Partners (the 8GB mail box) and one under the Recruiters account (validation nodes). WHMCS. rDNS is NOT set here, open a ticket, or use the NerdVM panel.",
  },
  {
    id: "racknerd-billing-2",
    service: "RackNerd (billing / client area)",
    vendor: "RackNerd",
    category: "Infrastructure",
    url: "https://my.racknerd.com/clientarea.php",
    account: "Account 2",
    used_for: "The second RackNerd client area: the validation nodes sit under one of these accounts",
    notes: "Three RackNerd client areas exist. Record here which boxes this one holds, because the invoices arrive per account and a box under the wrong account is a receipt that never reconciles.",
  },
  {
    id: "racknerd-billing-3",
    service: "RackNerd (billing / client area)",
    vendor: "RackNerd",
    category: "Infrastructure",
    url: "https://my.racknerd.com/clientarea.php",
    account: "Account 3",
    used_for: "The third RackNerd client area",
    notes: "Record which boxes this one holds.",
  },
  {
    id: "racknerd-nerdvm",
    service: "RackNerd NerdVM (SolusVM panel)",
    vendor: "RackNerd",
    category: "Infrastructure",
    url: "https://nerdvm.racknerd.com/login.php",
    used_for: "Reboot/rebuild the VPS boxes and set rDNS",
    username: "vmuser346309",
    account: "8GB Mailcow box (racknerd-3e842f5)",
    notes:
      "Different credentials from the billing client area. Reset the NerdVM password from billing → Reset NerdVM Password; that email has failed to arrive before, in which case open a ticket instead.",
  },
  {
    id: "vercel",
    service: "Vercel",
    vendor: "Vercel",
    category: "Infrastructure",
    url: "https://vercel.com/login",
    used_for: "Hosting for the Claimie, GTM OS and GlassNWA marketing sites",
    account: "ryan-nead-s-projects",
    notes: "Claimie is CLI-deployed (vercel deploy --prod) with no git integration, so a push does not ship it.",
  },
  {
    id: "aws",
    service: "AWS",
    vendor: "AWS",
    category: "Infrastructure",
    url: "https://console.aws.amazon.com/",
    used_for: "S3 for the video fleet, if that bucket is billed by AWS rather than Hetzner object storage",
    notes: "The only vendor on this list with a real invoice API (ListInvoiceSummaries + GetInvoicePDF).",
    envKey: "ROS_S3_ACCESS_KEY_ID",
  },
  {
    id: "github",
    service: "GitHub",
    vendor: "GitHub",
    category: "Infrastructure",
    url: "https://github.com/login",
    used_for: "neadusall/recruiteros and every other repo; the deploy watcher pulls from here",
    notes:
      "The production box has NO GitHub credentials by design, it is a pull-only deploy target, so pushes always come from Windows.",
  },

  /* ---------------- Domains & DNS ---------------- */
  {
    id: "cloudflare",
    service: "Cloudflare",
    vendor: "Cloudflare",
    category: "Domains & DNS",
    url: "https://dash.cloudflare.com/login",
    used_for: "DNS for the tal fleet, talentrecru.com and the sending domains",
    username: "ryan@dev.co",
    account: "0f0f7ff0aaafe9803a82ad1865ca03c9",
    notes:
      "A zone missing from THIS account is what makes a domain go dark even when the registrar points at the right nameservers, that is exactly how talsearches.com broke. Nameserver pairs are per-zone: byron+karsyn for the tal fleet, dee+phil elsewhere.",
  },
  {
    id: "dynadot",
    service: "Dynadot",
    vendor: "Dynadot",
    category: "Domains & DNS",
    url: "https://www.dynadot.com/account/sign-in",
    used_for: "The tal-brand fleet domains, talentrecru.com and the lume* batch",
    notes:
      "Prepaid account balance, not a card. The API is IP-allowlisted, add the machine's IP under Tools → API before any script will work. Password was pasted in chat on 2026-07-22 and should have been rotated; the platform uses a scoped API key, never the password.",
    envKey: "DYNADOT_API_KEY",
  },
  {
    id: "dynadot-2",
    service: "Dynadot",
    vendor: "Dynadot",
    category: "Domains & DNS",
    url: "https://www.dynadot.com/account/sign-in",
    account: "Account 2",
    used_for: "The second Dynadot account: record which names it holds",
    notes: "Each Dynadot account carries its own prepaid balance and its own IP allowlist for the API, so a script that works on one account fails on another until its IP is added there too.",
  },
  {
    id: "dynadot-3",
    service: "Dynadot",
    vendor: "Dynadot",
    category: "Domains & DNS",
    url: "https://www.dynadot.com/account/sign-in",
    account: "Account 3",
    used_for: "The third Dynadot account, if it exists: record which names it holds",
  },
  {
    id: "porkbun",
    service: "Porkbun",
    vendor: "Porkbun",
    category: "Domains & DNS",
    url: "https://porkbun.com/account/login",
    used_for: "The 15 Lume sending domains, and the registrar of record for Claimie",
    account: "Lume",
    notes:
      "API auth is apikey + secretapikey and charges the card on file (no prepaid balance). 'Opt In All Domains' must stay ON or existing domains are invisible to the API.",
  },
  {
    id: "godaddy",
    service: "GoDaddy",
    vendor: "GoDaddy",
    category: "Domains & DNS",
    url: "https://sso.godaddy.com/",
    used_for: "lumesp.com, claimie.ai and mytal.co, DNS included (ns*.domaincontrol.com)",
    notes:
      "Managed by hand, no API token on the server: the mail.lumesp.com and mail2 A records, the Resend/SES records and the Vercel records all live here. lumesp.com is deliberately NOT on Cloudflare.",
  },
  {
    id: "namecheap",
    service: "Namecheap",
    vendor: "Namecheap",
    category: "Domains & DNS",
    url: "https://www.namecheap.com/myaccount/login/",
    used_for: "glassnwa.com (BasicDNS, pointed at Vercel)",
  },

  /* ---------------- Email sending ---------------- */
  {
    id: "mailcow",
    service: "Mailcow admin (mail.lumesp.com)",
    vendor: "Mailcow",
    category: "Email sending",
    url: "https://mail.lumesp.com/admin",
    used_for: "The self-hosted mail server behind the 75-mailbox Lume sending fleet",
    notes:
      "Runs on the RackNerd 8GB box (173.254.242.194 / 192.3.221.194). Mailbox passwords live in claimie-mail\\mailbox-credentials.json; the API key is in that project's .env as MAILCOW_API_KEY.",
  },
  {
    id: "smartlead",
    service: "Smartlead",
    vendor: "Smartlead",
    category: "Email sending",
    url: "https://app.smartlead.ai/login",
    used_for: "Warm-up for the whole sending fleet (1,525 mailboxes)",
    notes:
      "Warm-up only, RecruitersOS does the actual sending. Billing runs through a Stripe-hosted portal linked off the billing page, charged around the 27th.",
  },
  {
    id: "sending-ac",
    service: "Sending.ac",
    vendor: "Sending.ac",
    category: "Email sending",
    url: "https://sso.ac/login?from=app.sending.ac",
    used_for: "The 1,450 managed mailboxes on the tal and lume domains",
    notes: "Signs in through sso.ac, not app.sending.ac directly.",
  },
  {
    id: "resend",
    service: "Resend",
    vendor: "Resend",
    category: "Email sending",
    url: "https://resend.com/login",
    used_for: "Portal and transactional email, and the Lume white-label SMTP relay",
    notes:
      "Relay is smtp.resend.com on port 587, 465 and 25 are blocked outbound on the ros box. A sending-only key cannot list domains (401 is expected, not a fault).",
    envKey: "RESEND_API_KEY",
  },
  {
    id: "microsoft365",
    service: "Microsoft 365 admin",
    vendor: "Microsoft 365",
    category: "Email sending",
    url: "https://admin.microsoft.com/",
    used_for: "lumesp.com mailboxes (ryan@lumesp.com) and the DKIM records for the M365 sending domains",
    username: "ryan@lumesp.com",
    notes:
      "Microsoft killed basic-auth SMTP in Sept 2025, so user/pass SMTP against this tenant is dead, that is why Resend relays instead. DKIM selector1/selector2 targets are copied from the DKIM page here.",
  },
  {
    id: "reoon",
    service: "Reoon Email Verifier",
    vendor: "Reoon",
    category: "Email sending",
    url: "https://emailverifier.reoon.com/login/",
    used_for: "Verifying decision-maker emails before anything is sent to them",
    notes:
      "Lifetime licence bought outright, so there is no subscription and no recurring receipt. Used because port 25 is blocked on the app box and an SMTP probe cannot run from there.",
    envKey: "REOON_API_KEY",
  },
  {
    id: "instantly",
    service: "Instantly",
    vendor: "Instantly",
    category: "Email sending",
    url: "https://app.instantly.ai/auth/login",
    used_for: "Alternate outreach sending provider wired behind a feature flag",
    envKey: "INSTANTLY_API_KEY",
  },
  {
    id: "billing-inbox",
    service: "Billing / resume mailbox (Google app passwords)",
    category: "Email sending",
    url: "https://myaccount.google.com/apppasswords",
    used_for: "The IMAP sweep that files vendor receipts, and the AI Vetting resume inbox",
    notes:
      "Not a vendor login, this is where the 16-character app passwords are issued for rrnead@gmail.com and neadusall@gmail.com. The credential on the box was dead as of 2026-07-31 and needs re-issuing here, then set-billing-inbox.sh.",
  },

  /* ---------------- Telephony & voice ---------------- */
  {
    id: "telnyx-house",
    service: "Telnyx (house account)",
    vendor: "Telnyx",
    category: "Telephony & voice",
    url: "https://portal.telnyx.com/",
    used_for: "OS Text SMS, BD Phone voice, number lookups and AI vetting minutes",
    notes:
      "Auto-recharge fires whenever the balance drops, so expect several top-up receipts a month on top of the monthly usage invoice.",
    envKey: "TELNYX_API_KEY",
  },
  {
    id: "telnyx-lume",
    service: "Telnyx (Lume account)",
    vendor: "Telnyx",
    category: "Telephony & voice",
    url: "https://portal.telnyx.com/",
    used_for: "Lume's own numbers, the five per-recruiter 929 lines, white-labelled off the house account",
    account: "Lume Search Partners",
    notes: "A genuinely separate Telnyx account. Its credentials are per-tenant, held in TENANT_TELNYX_CREDS, not in the house env.",
  },
  {
    id: "elevenlabs",
    service: "ElevenLabs",
    vendor: "ElevenLabs",
    category: "Telephony & voice",
    url: "https://elevenlabs.io/app/home",
    used_for: "The AI Vetting agent voice and the personalised-video voice (the Lukas clone)",
    envKey: "ELEVENLABS_API_KEY",
  },
  {
    id: "hume",
    service: "Hume AI",
    vendor: "Hume",
    category: "Telephony & voice",
    url: "https://app.hume.ai/",
    used_for: "Alternate voice engine for the vetting agent",
    notes: "platform.hume.ai redirects to app.hume.ai.",
    envKey: "HUME_API_KEY",
  },
  {
    id: "cartesia",
    service: "Cartesia",
    vendor: "Cartesia",
    category: "Telephony & voice",
    url: "https://play.cartesia.ai/",
    used_for: "Voice cloning fallback for the vetting and video stack",
    envKey: "CARTESIA_API_KEY",
  },

  /* ---------------- AI ---------------- */
  {
    id: "anthropic",
    service: "Anthropic Console",
    vendor: "Anthropic",
    category: "AI",
    url: "https://platform.claude.com/login",
    used_for: "Claude API: personalisation, reply classification, AI vetting, call notes",
    notes:
      "console.anthropic.com now redirects to platform.claude.com. Prepaid credit top-ups, so charges are irregular. An admin key unlocks the cost report endpoint; ordinary API keys do not.",
    envKey: "ANTHROPIC_API_KEY",
  },

  /* ---------------- Data & sourcing ---------------- */
  {
    id: "rapidapi",
    service: "RapidAPI",
    vendor: "RapidAPI",
    category: "Data & sourcing",
    url: "https://rapidapi.com/developer/dashboard",
    used_for: "JSearch job feed, skip tracing for Boost phones, and the LinkedIn people search",
    account: "11981388",
    notes:
      "One invoice covers all subscriptions, so a charge has to be split back out per listing by hand when the body does not name them. Billing lives at rapidapi.com/console/11981388/billing/transactions.",
    envKey: "RAPIDAPI_KEY",
  },
  {
    id: "serper",
    service: "Serper",
    vendor: "Serper.dev",
    category: "Data & sourcing",
    url: "https://serper.dev/dashboard",
    used_for: "The search credits behind the JD Sourcing wide pass",
    notes:
      "The single most important supply dependency: roughly 62% of all sourced candidates come through Serper, and the Lume workspace is the only one holding a key. Credits are prepaid and expire after 6 months.",
  },
  {
    id: "apify",
    service: "Apify",
    vendor: "Apify",
    category: "Data & sourcing",
    url: "https://console.apify.com/",
    used_for: "The direct-dial phone number finder actor",
    envKey: "APIFY_TOKEN",
  },
  {
    id: "koldinfo",
    service: "KoldInfo",
    vendor: "KoldInfo",
    category: "Data & sourcing",
    url: "https://app.koldinfo.com/",
    used_for: "The 129M people database and 57M business-email database behind DB enrichment",
    notes: "koldinfo.com redirects to app.koldinfo.com.",
  },
  {
    id: "laxis",
    service: "Laxis",
    vendor: "Laxis",
    category: "Data & sourcing",
    url: "https://app.laxis.tech/prospect-search",
    used_for: "The Laxis enrichment rung in the JD Sourcing chain",
    notes:
      "The product is on laxis.TECH, not laxis.com, app.laxis.com does not resolve. The worker signs in here with a real session, so a password change breaks enrichment until laxis-worker is updated.",
  },
  {
    id: "icypeas",
    service: "Icypeas",
    vendor: "Icypeas",
    category: "Data & sourcing",
    url: "https://app.icypeas.com/",
    used_for: "Email finding and verification in the enrichment chain",
    envKey: "ICYPEAS_API_KEY",
  },
  {
    id: "peopledatalabs",
    service: "People Data Labs",
    vendor: "People Data Labs",
    category: "Data & sourcing",
    url: "https://dashboard.peopledatalabs.com/",
    used_for: "Person enrichment fallback",
    envKey: "PDL_API_KEY",
  },
  {
    id: "adzuna",
    service: "Adzuna Developer",
    vendor: "Adzuna",
    category: "Data & sourcing",
    url: "https://developer.adzuna.com/login",
    used_for: "Job-posting feed for Hire Signals",
    notes: "Free tier, no invoice is ever issued, so a missing receipt here is correct.",
  },

  /* ---------------- Recruiting stack ---------------- */
  {
    id: "loxo",
    service: "Loxo",
    vendor: "Loxo",
    category: "Recruiting stack",
    url: "https://app.loxo.co/login",
    used_for: "The ATS: the People DB merged into Candidates, and the two-way activity sync",
    notes:
      "Every outbound channel checks Loxo activity before contacting anyone (14-day cooldown), so losing this account silently disables the no-double-contact guard.",
    envKey: "LOXO_API_KEY",
  },
  {
    id: "unipile",
    service: "Unipile",
    vendor: "Unipile",
    category: "Recruiting stack",
    url: "https://dashboard.unipile.com/",
    used_for: "LinkedIn OS: connected recruiter accounts and all LinkedIn messaging",
    notes: "The tool of record for LinkedIn. Without UNIPILE_DSN and UNIPILE_API_KEY the engine only simulates.",
    envKey: "UNIPILE_API_KEY",
  },
  {
    id: "linkedin",
    service: "LinkedIn (Ryan's account + Sales Navigator)",
    vendor: "LinkedIn",
    category: "Recruiting stack",
    url: "https://www.linkedin.com/login",
    used_for: "Sales Navigator searches pulled into JD Sourcing, and the account Unipile connects",
    username: "ryan@dev.co",
  },
  {
    id: "tidycal",
    service: "TidyCal",
    vendor: "TidyCal",
    category: "Recruiting stack",
    url: "https://tidycal.com/login",
    used_for: "Booking links in outreach sequences",
    envKey: "TIDYCAL_API_TOKEN",
  },

];
