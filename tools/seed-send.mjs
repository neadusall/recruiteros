// Seed inbox-placement test: send realistic campaign-style mail from 6 active
// Sending.ac boxes to 4 Gmail seed boxes we control (+ owner's Gmail), staggered.
const KEY = process.env.SENDINGAC_MAILBOX_API_KEY;
const BASE = "https://api.customers.ac/api/mailbox/v1alpha1/azure/v1.0";

const SENDERS = [
  { email: "rnead@lumerecruiters.com", name: "Ryan Nead" },
  { email: "nead.r@lumetalentsearch.com", name: "Ryan Nead" },
  { email: "ryan.nead@lumesearchgroup.com", name: "Ryan Nead" },
  { email: "ryann@lumeplacement.com", name: "Ryan Nead" },
  { email: "ryan.nead@lumeprofessional.com", name: "Ryan Nead" },
  { email: "rn@lumepeople.com", name: "Ryan Nead" },
];
const SEEDS = [
  { email: "sam@lumesearchgroupmusic.com", first: "Sam", company: "Harborline" },
  { email: "noah@artlumesearchgroup.com", first: "Noah", company: "Crestpoint" },
  { email: "josh@lumesearchgroupmusic.com", first: "Josh", company: "Fairwater" },
  { email: "ryan@newlumesearchgroup.com", first: "Ryan", company: "Bluepeak" },
  { email: "neadusall@gmail.com", first: "Ryan", company: "Northgate" },
];

const ROLES = ["Accounting Manager", "Senior Financial Analyst", "Tax Manager", "Controller", "FP&A Manager", "Audit Senior Manager"];
const OPENERS = [
  "Just wrapped a search for another company in your space and have a couple of",
  "We recently closed out a search nearby and came away with a few strong",
  "Coming off a placement in a similar business, I still have two vetted",
];
const CLOSERS = [
  "Worth a quick call to walk through who we have?",
  "Open to a short call this week to compare notes?",
  "Happy to send both profiles over if useful.",
];

async function send(from, fromName, to, subject, body) {
  const res = await fetch(`${BASE}/users/${encodeURIComponent(from)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ message: { subject, body: { contentType: "Text", content: body }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true }),
    signal: AbortSignal.timeout(30000),
  });
  return res.status;
}

const results = [];
let n = 0;
for (const seed of SEEDS) {
  for (const s of SENDERS) {
    const role = ROLES[n % ROLES.length];
    const opener = OPENERS[n % OPENERS.length];
    const closer = CLOSERS[n % CLOSERS.length];
    const subject = `${role.toLowerCase()} candidates for ${seed.company.toLowerCase()}`;
    const body = `Hi ${seed.first},\n\n${opener} ${role}s on my bench who map cleanly to what you're building at ${seed.company}. Both have solid technical chops and know how to keep a close cycle tight while the team scales. ${closer}\n\nBest,\n${s.name}\nLume Search Partners\n929-543-0608\n\nLume Search Partners · 148 Doughty Blvd, Inwood, NY 11096`;
    try {
      const code = await send(s.email, s.name, seed.email, subject, body);
      results.push({ from: s.email, to: seed.email, subject, code });
      console.log(`${s.email} -> ${seed.email}: ${code}`);
    } catch (e) {
      results.push({ from: s.email, to: seed.email, subject, err: String(e.message).slice(0, 80) });
      console.log(`${s.email} -> ${seed.email}: ERR ${e.message}`);
    }
    n++;
    await new Promise((r) => setTimeout(r, 4000 + Math.floor(n % 3) * 1500));
  }
}
console.log(JSON.stringify({ sent: results.filter((r) => r.code === 202 || r.code === 200).length, total: results.length }));
