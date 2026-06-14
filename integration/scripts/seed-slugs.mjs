/* ============================================================
   RecruitersOS · ATS board seed slugs
   Public job-board identifiers for companies on Greenhouse, Lever,
   and Ashby. The harvester pulls each board's PUBLIC JSON (no auth)
   to discover open roles = real companies that are hiring.

   Wrong/stale slugs simply 404 and are skipped, so it is safe to
   cast a wide net. Add slugs freely to grow the database.
   ============================================================ */

// Greenhouse: https://boards-api.greenhouse.io/v1/boards/<slug>/jobs
export const GREENHOUSE = [
  "stripe","airbnb","robinhood","databricks","dropbox","coinbase","doordash","instacart",
  "asana","gitlab","hashicorp","cloudflare","snyk","brex","plaid","ramp","retool","scaleai",
  "sofi","twilio","affirm","benchling","samsara","niantic","pinterest","reddit","discord",
  "figma","airtable","amplitude","mixpanel","segment","gusto","carta","flexport","faire",
  "checkr","verkada","gem","lattice","webflow","vimeo","squarespace","peloton","wayfair",
  "betterup","chime","creditkarma","nerdwallet","marqeta","upstart","brexhq","mercury",
  "anduril","rippling","deel","remote","whoop","oura","calm","headspace","noom","ro",
  "hims","cerebral","devoted","cityblock","cohere","huggingface","weaviate","pinecone",
  "anthropic","openai","perplexityai","databook","glean","writer","jasper","runwayml",
  "clari","outreach","gong","apollo","6sense","drift","chili","zoominfo","lusha",
  "thumbtack","angi","houzz","opendoor","compass","betterment","wealthfront","public",
  "alto","newfront","ethos","root","clearcover","hippo","kin","openstore","bolt",
  "fastly","datadog","newrelic","sumologic","pagerduty","gitpod","render","planetscale",
  "cockroachlabs","timescale","clickhouse","starburst","dbt","fivetran","airbyte","census",
  "hightouch","monte","atlan","secoda","greatexpectations","tecton","arize","weightsandbiases",
  "modal","baseten","together","fal","groq","lambdalabs","coreweave","crusoe","vast",
  "discordapp","patreon","substack","ghost","beehiiv","cameo","whatnot","poshmark","depop",
  "faireapp","shippo","easypost","loop","aftership","narvar","gorgias","kustomer","front",
  "intercom","zendesk","freshworks","helpscout","klaus","assembled","assembledhq","forethought",
  "scale","labelbox","snorkel","surgehq","sama","appen","superannotate","encord","roboflow",
  "verily","tempus","flatiron","komodo","truveta","abridge","nuance","suki","corti","hippocratic",
  "duolingo","grammarly","canva","miro","loom","calendly","clickup","monday","smartsheet","coda",
  "zapier","make","workato","tray","postman","kong","apollographql","graphql","temporal","airplane",
  "vanta","drata","secureframe","wiz","orca","lacework","sysdig","aquasec","semgrep","chainguard",
  "anchorage","fireblocks","chainalysis","trmlabs","alchemy","quicknode","circle","paxos","gemini",
  "kraken","blockchain","consensys","matterlabs","optimism","uniswaplabs","dydx","aave",
  "warbyparker","allbirds","glossier","everlane","reformation","rothys","figs","onepeloton",
  "sweetgreen","cava","chipotle","toasttab","squareup","block","afterpay","klarna","sezzle",
  "nubank","mercadolibre","rappi","kavak","clip","bitso"," comefutures","konfio","clara",
  "gympass","wellhub","classpass","mindbodyonline","hingehealth","swordhealth","spring",
  "lyra","modernhealth","talkspace","betterhelp","grow","alma","headway","two-chairs",
  "navan","tripactions","spotnana","hopper","getaround","turo","outdoorsy","wheelhouse",
  "faire","ankorstore","mirakl","fabric","commercetools","bigcommerce","swell","nacelle",
  " from","sentry","launchdarkly","split","statsig","optimizely","amplitude","heap","fullstory",
  "contentful","sanity","storyblok","prismic","builderio","strapi","payloadcms","hygraph",
];

// Lever: https://api.lever.co/v0/postings/<slug>?mode=json
export const LEVER = [
  "leadiq","match","plaid","brex","netlify","gem","ironclad","handshake","attentive",
  "ramp","mux","census","modernhealth","spring","quora","kong","temporal","cortex",
  "vercel","clipboard","clipboardhealth","included","includedhealth","spotai","veho",
  "fountain","alloy","alloy","unit","highnote","increase","moov","finix","payabli",
  "tala","branch","oportun","petal","tally","monarch","copilotmoney","origin","rocketmoney",
  "lateral","numeralhq","metronome","orum","tremendous","trunk","trunktools","sourcegraph",
  "doximity","wellsky","commure","fabrichealth","memora","wellframe","vimeo","ro","cedar",
  "shopmonkey","fountainpay","mercury","lithic","unit21","alloycard","sardine","persona",
  "alloyidentity","middesk","stytch","workos","clerk","propelauth","frontegg","descope",
  "1password","tailscale","teleport","oso","aembit","oort","nudgesecurity","vanta","drata",
  "secureframe","tugboat","thoropass","scrut","sprinto","conveyor","whistic","safebase",
];

// Ashby: https://api.ashbyhq.com/posting-api/job-board/<slug>
export const ASHBY = [
  "ashby","linear","vercel","replit","supabase","deel","ramp","openai","runway","mistral",
  "notion","loom","cron","raycast","arc","browserco","warp","fig","zed","tldraw",
  "posthog","june","mixpanel","amplitude","statsig","launchdarkly","flagsmith","unleash",
  "rippling","gusto","mercury","brex","pilot","puzzl","digits","rho","relay","meow",
  "clay","apollo","instantly","smartlead","lemlist","la-growth-machine","heyreach",
  "hex","deepnote","mode","count","equals","rows","grid","causal","runwayfinancial",
  "cursor","anysphere","codeium","tabnine","sourcegraph","sweep","cognition","magic",
  "harvey","robinai","spellbook","eveai","casetext","legora","luminance","ironcladhq",
  "perplexity","glean","sana","dust","adept","imbue","reka","contextual","you",
  "scale","labelbox","humanloop","langchain","llamaindex","baseten","modal","replicate",
];
