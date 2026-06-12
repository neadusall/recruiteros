/**
 * Generator for the RecruiterOS "Multi-Channel Outreach Router (4 Scenarios)"
 * n8n workflow. Run:  node docs/integrations/n8n/build-workflow.cjs
 * Emits recruiteros-outreach-router.json next to this file.
 *
 * Why a generator: the workflow embeds multi-line Code-node JavaScript. Building
 * the object in JS and JSON.stringify-ing it guarantees valid, importable JSON
 * (no hand-escaped newlines to get wrong).
 */
const fs = require("fs");
const path = require("path");

// Stable ids so re-running produces a clean diff instead of churn.
const ID = (n) => `ros-n8n-${n}`;
let X = 0;
const col = () => (X += 1, 240 * X); // left-to-right lanes
const lane = (i) => 120 + i * 200; // vertical lane per scenario

/* ----------------------------- Code: Classify ---------------------------- */
const classifyCode = `
// === EDIT THESE DEFAULTS (one place) =====================================
const CONFIG = {
  baseUrl: 'https://YOUR-RECRUITEROS-HOST',   // your app origin, NO trailing slash
  defaultCampaignId: 'CHANGE_ME',             // fallback campaign id
  voiceNoteThreshold: 80,                      // warmth gate for voice (RecruiterOS default)
};
// =========================================================================

// Accept {person:{...}}, a raw webhook body, or a flat object.
const p = $json.person || $json.body?.person || $json.body || $json;

const titleText = String(p.title || p.headline || '').toLowerCase();

// --- job function (mirrors integration/lib/signals/filters.ts) ---
const FUNCTION_KEYWORDS = [
  ['executive',        /(chief|ceo|founder|owner|president|managing director|partner)/],
  ['engineering',      /(engineer|developer|swe|devops|sre|architect|backend|front[- ]?end|full[- ]?stack|programmer)/],
  ['product',          /(product manager|product owner|head of product|cpo|product lead)/],
  ['design',           /(designer|ux|ui|creative director)/],
  ['data',             /(data scientist|data engineer|analytics|machine learning|ml engineer|data analyst)/],
  ['sales',            /(sales|account executive|\\bae\\b|sdr|bdr|business development|revenue)/],
  ['marketing',        /(marketing|growth|demand gen|brand|content lead|seo)/],
  ['finance',          /(finance|accountant|controller|cfo|fp&a|treasur)/],
  ['operations',       /(operations|\\bops\\b|coo|logistics|supply chain)/],
  ['people_hr',        /(recruit|talent|people ops|\\bhr\\b|human resources|chro)/],
  ['customer_success', /(customer success|csm|account manager)/],
  ['legal',            /(legal|counsel|attorney|compliance)/],
];
let fn = 'other';
for (const [name, re] of FUNCTION_KEYWORDS) { if (re.test(titleText)) { fn = name; break; } }

// --- seniority (order matters: most senior first) ---
const SENIORITY_KEYWORDS = [
  ['founder',  /(founder|co[- ]?founder|owner)/],
  ['c_level',  /(chief|\\bceo\\b|\\bcfo\\b|\\bcoo\\b|\\bcto\\b|\\bcmo\\b|\\bcpo\\b|\\bcro\\b|\\bchro\\b|c-level|cxo)/],
  ['vp',       /(\\bvp\\b|vice president|\\bsvp\\b|\\bevp\\b)/],
  ['director', /(director|head of)/],
  ['manager',  /(manager|team lead|principal)/],
  ['senior',   /(senior|\\bsr\\.?\\b|staff)/],
];
let sen = 'mid';
for (const [name, re] of SENIORITY_KEYWORDS) { if (re.test(titleText)) { sen = name; break; } }
const decisionRanks = ['manager','director','vp','c_level','founder'];
const isDecisionMaker = decisionRanks.includes(sen);

// --- industry: explicit p.industry wins, else infer from company/headline ---
const INDUSTRY_KEYWORDS = [
  ['healthcare',    /(health|clinic|hospital|medical|pharma|biotech|\\bcare\\b)/],
  ['fintech',       /(fintech|\\bbank|payment|lending|insurance|insurtech|trading|crypto|wealth)/],
  ['cybersecurity', /(security|cyber|infosec|appsec)/],
  ['ai_ml',         /(\\bai\\b|artificial intelligence|machine learning|\\bml\\b|\\bllm\\b)/],
  ['ecommerce',     /(ecommerce|e-commerce|retail|marketplace|shopify|\\bd2c\\b)/],
  ['edtech',        /(edtech|education|learning|university|school)/],
  ['logistics',     /(logistics|supply chain|freight|shipping|warehouse)/],
  ['gaming',        /(gaming|game studio|esports)/],
  ['climate',       /(climate|clean energy|sustainab|carbon|renewable)/],
  ['saas',          /(saas|software|\\bcloud\\b|platform|\\bb2b\\b)/],
];
let industry = 'general';
const industryText = String(p.industry || p.company || p.companyDescription || p.headline || '').toLowerCase();
for (const [name, re] of INDUSTRY_KEYWORDS) { if (re.test(industryText)) { industry = name; break; } }
if (p.industry) industry = String(p.industry).toLowerCase().trim() || industry;

// --- warmth + motion ---
let warmth = Number(p.warmth);
if (!Number.isFinite(warmth)) warmth = 50;
const hot = warmth >= CONFIG.voiceNoteThreshold;
const motion = p.motion === 'recruiting' ? 'recruiting'
             : p.motion === 'bd' ? 'bd'
             : (fn === 'people_hr' || fn === 'engineering') ? 'recruiting' : 'bd';

// --- scenario routing: SENIORITY x WARMTH (the 4 playbooks) ---
let scenario, scenarioName;
if (isDecisionMaker && hot)        { scenario = 1; scenarioName = 'Decision-maker - warm: voice-first multi-channel'; }
else if (isDecisionMaker)          { scenario = 2; scenarioName = 'Decision-maker - cold: full 28-day multi-channel drip'; }
else if (warmth >= 35 || ['senior','manager','lead'].includes(sen) || ['engineering','product','sales'].includes(fn))
                                   { scenario = 3; scenarioName = 'Manager / IC: LinkedIn-led + email'; }
else                               { scenario = 4; scenarioName = 'Cold / low-warmth: email-only nurture'; }

return {
  person: p,
  classification: { function: fn, seniority: sen, isDecisionMaker, industry, warmth, hot, motion },
  scenario,
  scenarioName,
  baseUrl: CONFIG.baseUrl.replace(/\\/$/, ''),
  defaultCampaignId: CONFIG.defaultCampaignId,
  voiceNoteThreshold: CONFIG.voiceNoteThreshold,
};
`.trim();

/* --------- Code: each scenario merges its playbook into the item -------- */
// Encodes outreach best practice as a channel cadence + which content + which
// tagged sequence to enroll into. Edit campaignId / sequenceTag / channels here.
const scenarioPlans = {
  1: {
    methodology: "voice_first",
    sequenceTag: "scenario-1-voicefirst",
    contentTypes: "value_prop,case_study,video_script",
    channels: "linkedin_connect, linkedin_voice_note, voice_drop, email, linkedin_message",
    note: "Warm decision-maker. Day0 email signal-opener + LinkedIn connect (no note). Day1 voicemail drop (cloned voice). Day2 LinkedIn voice note referencing the trigger. Day3 value drop. Highest-touch, fastest.",
  },
  2: {
    methodology: "seven_touch_drip",
    sequenceTag: "scenario-2-multichannel",
    contentTypes: "value_prop,case_study,comp_benchmark",
    channels: "email, linkedin_connect, linkedin_message, voice_drop, linkedin_voice_note",
    note: "Cold decision-maker. Full 28-day anatomy: 7 email touches + 6 LinkedIn touches; voice note unlocks only once warmth >= threshold. Connect-before-DM enforced by RecruiterOS.",
  },
  3: {
    methodology: "hiring_manager_outreach",
    sequenceTag: "scenario-3-linkedin-led",
    contentTypes: "value_prop,case_study",
    channels: "linkedin_connect, linkedin_message, email",
    note: "Manager / individual contributor. LinkedIn-led (connect -> engage -> DM), email as the fallback channel. No voicemail drop at this tier.",
  },
  4: {
    methodology: "seven_touch_drip",
    sequenceTag: "scenario-4-email-nurture",
    contentTypes: "value_prop,comp_benchmark",
    channels: "email",
    note: "Cold / low-warmth. Email-only 7-touch nurture, slow cadence, ends on the break-up touch then moves to 90-day nurture.",
  },
};
const planCode = (n) => {
  const p = scenarioPlans[n];
  return `
const inb = $json;
return {
  ...inb,
  plan: {
    scenario: ${n},
    campaignId: inb.defaultCampaignId,          // <- route to the campaign that owns this segment's content
    motion: inb.classification.motion,
    methodology: ${JSON.stringify(p.methodology)},
    sequenceTag: ${JSON.stringify(p.sequenceTag)},
    contentTypes: ${JSON.stringify(p.contentTypes)},
    channels: ${JSON.stringify(p.channels)},
    note: ${JSON.stringify(p.note)},
  },
};
`.trim();
};

/* ------------------------- Code: Assemble Plan -------------------------- */
const assembleCode = `
// Single consolidation point after the Switch. Every downstream node reads
// from $('Assemble Plan') so it does not matter which scenario branch fired.
return { ...$json };
`.trim();

/* ------------------------- Code: Pick Sequence -------------------------- */
const pickSequenceCode = `
const plan = $('Assemble Plan').item.json;
const seqs = $json.sequences || [];
const tag = String(plan.plan.sequenceTag || '').toLowerCase();

function match(s) {
  const tags = (s.tags || []).map(t => String(t).toLowerCase());
  const name = String(s.name || '').toLowerCase();
  if (tags.includes(tag)) return 3;
  if (name.includes(tag)) return 2;
  return 0;
}
const ranked = seqs.map(s => ({ s, score: match(s) })).filter(r => r.score > 0).sort((a, b) => b.score - a.score);
const chosen = ranked[0] && ranked[0].s;

return {
  ...plan,
  sequenceId: chosen ? chosen.id : null,
  sequenceName: chosen ? chosen.name : null,
  sequenceWarning: chosen ? null
    : 'No sequence tagged "' + tag + '" for motion ' + plan.plan.motion + '. Build a multi-channel sequence in Campaigns and tag it "' + tag + '".',
};
`.trim();

/* --------------------------- HTTP body exprs ---------------------------- */
const prospectBody = `={{ JSON.stringify({
  fullName: $('Pick Sequence').item.json.person.fullName || $('Pick Sequence').item.json.person.name,
  campaignId: $('Pick Sequence').item.json.plan.campaignId,
  motion: $('Pick Sequence').item.json.plan.motion,
  email: $('Pick Sequence').item.json.person.email,
  linkedinUrl: $('Pick Sequence').item.json.person.linkedinUrl || $('Pick Sequence').item.json.person.linkedin,
  phone: $('Pick Sequence').item.json.person.phone,
  company: $('Pick Sequence').item.json.person.company,
  companyDomain: $('Pick Sequence').item.json.person.companyDomain,
  title: $('Pick Sequence').item.json.person.title,
  headline: $('Pick Sequence').item.json.person.headline,
  location: $('Pick Sequence').item.json.person.location,
  warmth: $('Pick Sequence').item.json.classification.warmth
}) }}`;

const enrollBody = `={{ JSON.stringify({
  action: 'bulk-update',
  ids: [$('Upsert Prospect').item.json.prospect.id],
  sequenceId: $('Pick Sequence').item.json.sequenceId,
  sequenceName: $('Pick Sequence').item.json.sequenceName,
  status: 'in_sequence'
}) }}`;

const respondBody = `={{ JSON.stringify({
  ok: true,
  scenario: $('Pick Sequence').item.json.scenario,
  scenarioName: $('Pick Sequence').item.json.scenarioName,
  classification: $('Pick Sequence').item.json.classification,
  routedTo: {
    campaignId: $('Pick Sequence').item.json.plan.campaignId,
    methodology: $('Pick Sequence').item.json.plan.methodology,
    channels: $('Pick Sequence').item.json.plan.channels
  },
  prospectId: $('Upsert Prospect').item.json.prospect.id,
  sequence: { id: $('Pick Sequence').item.json.sequenceId, name: $('Pick Sequence').item.json.sequenceName },
  craftedPreview: ($('Craft Preview').item.json.touches || []).map(t => ({ channel: t.channel, action: t.action, day: t.day, name: t.name, subject: t.subject, body: t.body })),
  warnings: [
    $('Pick Sequence').item.json.sequenceWarning
  ].filter(Boolean)
}) }}`;

/* --------------------------- node factories ----------------------------- */
const httpGet = (name, urlExpr, pos) => ({
  parameters: {
    method: "GET",
    url: urlExpr,
    authentication: "genericCredentialType",
    genericAuthType: "httpHeaderAuth",
    options: {},
  },
  id: ID(name.replace(/\s+/g, "-").toLowerCase()),
  name,
  type: "n8n-nodes-base.httpRequest",
  typeVersion: 4.2,
  position: pos,
  credentials: { httpHeaderAuth: { id: "REPLACE_WITH_CREDENTIAL_ID", name: "RecruiterOS API" } },
});

const httpPost = (name, urlExpr, bodyExpr, pos) => ({
  parameters: {
    method: "POST",
    url: urlExpr,
    authentication: "genericCredentialType",
    genericAuthType: "httpHeaderAuth",
    sendBody: true,
    specifyBody: "json",
    jsonBody: bodyExpr,
    options: {},
  },
  id: ID(name.replace(/\s+/g, "-").toLowerCase()),
  name,
  type: "n8n-nodes-base.httpRequest",
  typeVersion: 4.2,
  position: pos,
  credentials: { httpHeaderAuth: { id: "REPLACE_WITH_CREDENTIAL_ID", name: "RecruiterOS API" } },
});

const codeNode = (name, code, pos) => ({
  parameters: { mode: "runOnceForEachItem", language: "javaScript", jsCode: code },
  id: ID(name.replace(/\s+/g, "-").toLowerCase()),
  name,
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position: pos,
});

/* ------------------------------- nodes ---------------------------------- */
const webhook = {
  parameters: {
    httpMethod: "POST",
    path: "recruiteros/outreach",
    responseMode: "responseNode",
    options: {},
  },
  id: ID("webhook"),
  name: "Person In (Webhook)",
  type: "n8n-nodes-base.webhook",
  typeVersion: 2,
  position: [col(), lane(1.5)],
  webhookId: ID("webhook"),
};

const classify = codeNode("Classify & Route", classifyCode, [col(), lane(1.5)]);

// Switch on scenario (1..4)
const switchX = col();
const mkCond = (val) => ({
  options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
  conditions: [
    {
      id: ID("cond-" + val),
      leftValue: "={{ $json.scenario }}",
      rightValue: val,
      operator: { type: "number", operation: "equals" },
    },
  ],
  combinator: "and",
});
const switchNode = {
  parameters: {
    rules: {
      values: [
        { conditions: mkCond(1), renameOutput: true, outputKey: "S1 voice-first" },
        { conditions: mkCond(2), renameOutput: true, outputKey: "S2 multi-channel" },
        { conditions: mkCond(3), renameOutput: true, outputKey: "S3 linkedin-led" },
        { conditions: mkCond(4), renameOutput: true, outputKey: "S4 email-nurture" },
      ],
    },
    options: { fallbackOutput: "none" },
  },
  id: ID("switch"),
  name: "Route by Scenario",
  type: "n8n-nodes-base.switch",
  typeVersion: 3.2,
  position: [switchX, lane(1.5)],
};

// 4 scenario plan nodes
const planX = col();
const planNodes = [1, 2, 3, 4].map((n, i) =>
  codeNode(`Scenario ${n} Playbook`, planCode(n), [planX, lane(i)]),
);

const assemble = codeNode("Assemble Plan", assembleCode, [col(), lane(1.5)]);

const getSequences = httpGet(
  "Fetch Sequences",
  "={{ $('Assemble Plan').item.json.baseUrl }}/api/sequences?motion={{ $('Assemble Plan').item.json.plan.motion }}",
  [col(), lane(1.5)],
);
const pickSequence = codeNode("Pick Sequence", pickSequenceCode, [col(), lane(1.5)]);

const upsertProspect = httpPost(
  "Upsert Prospect",
  "={{ $('Assemble Plan').item.json.baseUrl }}/api/prospects",
  prospectBody,
  [col(), lane(1.5)],
);
const enroll = httpPost(
  "Enroll in Sequence",
  "={{ $('Assemble Plan').item.json.baseUrl }}/api/prospects",
  enrollBody,
  [col(), lane(1.5)],
);
// Preview the actual targeted copy the content library will craft for this lead
// (industry x function x seniority x signal x motion), rendered server-side.
const craftPreview = httpGet(
  "Craft Preview",
  "={{ $('Assemble Plan').item.json.baseUrl }}/api/content/craft" +
    "?function={{ $('Assemble Plan').item.json.classification.function }}" +
    "&seniority={{ $('Assemble Plan').item.json.classification.seniority }}" +
    "&industry={{ $('Assemble Plan').item.json.classification.industry }}" +
    "&motion={{ $('Assemble Plan').item.json.plan.motion }}" +
    "&warmth={{ $('Assemble Plan').item.json.classification.warmth }}" +
    "&company={{ encodeURIComponent($('Pick Sequence').item.json.person.company || '') }}" +
    "&title={{ encodeURIComponent($('Pick Sequence').item.json.person.title || '') }}",
  [col(), lane(1.5)],
);

const cadence = httpPost(
  "Trigger Cadence Draft",
  "={{ $('Assemble Plan').item.json.baseUrl }}/api/campaigns/cadence",
  "={{ JSON.stringify({}) }}",
  [col(), lane(1.5)],
);
cadence.parameters.options = { ...cadence.parameters.options };
cadence.notesInFlow = true;
cadence.notes = "Drafts the enrolled prospect into the approval queue (safe: does NOT auto-send). Remove if you run the daily cadence cron instead.";

const respond = {
  parameters: { respondWith: "json", responseBody: respondBody, options: {} },
  id: ID("respond"),
  name: "Respond",
  type: "n8n-nodes-base.respondToWebhook",
  typeVersion: 1.1,
  position: [col(), lane(1.5)],
};

const nodes = [
  webhook, classify, switchNode, ...planNodes, assemble,
  getSequences, pickSequence,
  upsertProspect, enroll, craftPreview, cadence, respond,
];

/* ---------------------------- connections ------------------------------- */
const conn = (from, to, fromIndex = 0) => ({
  [from]: { main: [] },
});
const connections = {};
const link = (from, to, outIndex = 0) => {
  connections[from] = connections[from] || { main: [] };
  while (connections[from].main.length <= outIndex) connections[from].main.push([]);
  connections[from].main[outIndex].push({ node: to, type: "main", index: 0 });
};

link("Person In (Webhook)", "Classify & Route");
link("Classify & Route", "Route by Scenario");
link("Route by Scenario", "Scenario 1 Playbook", 0);
link("Route by Scenario", "Scenario 2 Playbook", 1);
link("Route by Scenario", "Scenario 3 Playbook", 2);
link("Route by Scenario", "Scenario 4 Playbook", 3);
for (const n of [1, 2, 3, 4]) link(`Scenario ${n} Playbook`, "Assemble Plan");
link("Assemble Plan", "Fetch Sequences");
link("Fetch Sequences", "Pick Sequence");
link("Pick Sequence", "Upsert Prospect");
link("Upsert Prospect", "Enroll in Sequence");
link("Enroll in Sequence", "Craft Preview");
link("Craft Preview", "Trigger Cadence Draft");
link("Trigger Cadence Draft", "Respond");

const workflow = {
  name: "RecruiterOS - Multi-Channel Outreach Router (4 Scenarios)",
  nodes,
  connections,
  active: false,
  settings: { executionOrder: "v1" },
  pinData: {},
  meta: { templateId: "recruiteros-outreach-router-v1" },
  tags: [{ name: "recruiteros" }, { name: "outreach" }],
};

const out = path.join(__dirname, "recruiteros-outreach-router.json");
fs.writeFileSync(out, JSON.stringify(workflow, null, 2));
console.log("Wrote", out, "(" + nodes.length + " nodes)");
