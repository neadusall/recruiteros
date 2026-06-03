/* Headless verification of the Sales Navigator scraper against a SIMULATED
   virtualized list (only a few cards exist in the DOM at once and recycle as you
   scroll — exactly what made it grab 16/25). Proves per-page completeness, no
   dedup drops, and correct field cleaning. No browser, no LinkedIn.

   Run:  node extension/salesnav.test.cjs   (jsdom comes from integration/) */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const { JSDOM } = require(path.join(ROOT, 'integration', 'node_modules', 'jsdom'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  \x1b[32mok\x1b[0m   ' + n); } else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + n + (x ? ' -> ' + x : '')); } };

// ---- build a jsdom page that virtualizes a list of `leads` (window of W) ----
function makeHarness(leads, opts) {
  opts = opts || {};
  const W = opts.window || 8;          // how many cards live in the DOM at once
  const STEP = opts.step || 4;         // how far each scrollIntoView advances
  const dom = new JSDOM('<!DOCTYPE html><body><div id="results"></div></body>', {
    url: 'https://www.linkedin.com/sales/search/people?query=test',
    pretendToBeVisual: true, runScripts: 'outside-only',
  });
  const { window } = dom;
  const doc = window.document;

  // speed up: make sleep() resolve almost instantly
  const realST = global.setTimeout;
  window.setTimeout = (cb) => realST(cb, 0);
  window.scrollTo = () => {}; window.scrollBy = () => {}; // jsdom has no layout; silence

  // chrome + ROS mocks (real cleaners loaded below)
  window.chrome = {
    storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
    runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {}, lastError: null },
  };

  let start = 0;
  const listEl = doc.getElementById('results');
  function render() {
    listEl.innerHTML = '';
    const end = Math.min(start + W, leads.length);
    for (let i = start; i < end; i++) {
      const L = leads[i];
      const li = doc.createElement('li');
      li.className = 'artdeco-list__item';
      // name links to the person's OWN sales/lead URL (unique). Optional shared
      // mutual-connection /in/ link OUTSIDE the lockup (must NOT be grabbed).
      li.innerHTML =
        '<div class="artdeco-entity-lockup">' +
          '<a href="' + (L.nameHref || ('/sales/lead/' + L.id + ',NAME_SEARCH')) + '">' +
            '<span data-anonymize="person-name">' + L.name + '</span></a>' +
          '<span data-anonymize="title">' + (L.title || '') + '</span>' +
          '<span data-anonymize="company-name">' + (L.company || '') + '</span>' +
          '<span data-anonymize="location">' + (L.location || '') + '</span>' +
        '</div>' +
        (opts.sharedInsight ? '<div class="insight"><a href="/in/mutual-connection">12 shared</a></div>' : '');
      listEl.appendChild(li);
    }
  }
  // virtualization driver: scrollIntoView advances the rendered window + recycles
  window.Element.prototype.scrollIntoView = function () {
    start = Math.min(start + STEP, Math.max(0, leads.length - W));
    render();
  };
  window.HTMLElement.prototype.scrollIntoView = window.Element.prototype.scrollIntoView;
  render();

  // load the REAL shared cleaners, then the REAL scraper (exposes window.__rosSN)
  window.eval(fs.readFileSync(path.join(ROOT, 'extension/lib/messaging.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'extension/content/salesnav.js'), 'utf8'));
  return window;
}

function leadset(n, extra) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(Object.assign({ id: 'L' + i, name: 'Person ' + i, title: 'Engineer ' + i, company: 'Co ' + i, location: 'City ' + i }, extra ? extra(i) : {}));
  return out;
}

(async () => {
  console.log('\n\x1b[1mSales Navigator scraper — virtualized capture\x1b[0m');

  // 1) 25 leads, only 8 in the DOM at a time → must still capture all 25
  {
    const w = makeHarness(leadset(25), { window: 8, step: 4 });
    const recs = await w.__rosSN.scrapePageProgressively('t');
    ok('captures ALL 25 from a virtualized 8-at-a-time list', recs.length === 25, 'got ' + recs.length);
    const ids = new Set(recs.map(r => r.salesNavUrl));
    ok('all 25 are distinct leads (unique lead URLs, none dropped)', ids.size === 25, ids.size + ' distinct');
  }

  // 2) shared mutual-connection /in/ link in every card must NOT collapse them
  {
    const w = makeHarness(leadset(25), { window: 8, step: 4, sharedInsight: true });
    const recs = await w.__rosSN.scrapePageProgressively('t');
    ok('shared /in/ insight link does NOT cause dedup collisions', recs.length === 25, 'got ' + recs.length);
    ok('profileUrl not mis-grabbed from the shared insight link', recs.every(r => !/mutual-connection/.test(r.profileUrl || '')));
  }

  // 3) a big list (137) with a tiny DOM window (6) — stress the recycling
  {
    const w = makeHarness(leadset(137), { window: 6, step: 3 });
    const recs = await w.__rosSN.scrapePageProgressively('t');
    ok('captures ALL 137 with a 6-card window', recs.length === 137, 'got ' + recs.length);
  }

  // 4) field cleaning + correct keys on a regular-search page (name links to /in/)
  {
    const leads = [
      { id: 'A', name: 'Jane Doe, MBA', title: 'VP Eng 🚀', company: 'Globex, Inc.', location: 'Berlin', nameHref: 'https://www.linkedin.com/in/janedoe' },
      { id: 'B', name: 'Dr. John Smith', title: 'Head of Talent', company: 'Initech LLC', location: 'NYC', nameHref: 'https://www.linkedin.com/in/johnsmith' },
    ];
    const w = makeHarness(leads, { window: 8 });
    const recs = w.__rosSN.scrapeCurrentPage('t');
    const jane = recs.find(r => /Jane/.test(r.fullName));
    ok('name cleaned (Jane Doe, MBA -> Jane Doe)', jane && jane.fullName === 'Jane Doe', jane && jane.fullName);
    ok('company cleaned (Globex, Inc. -> Globex)', jane && jane.company === 'Globex', jane && jane.company);
    ok('headline emoji stripped', jane && !/🚀/.test(jane.headline || ''), jane && jane.headline);
    ok('own /in/ profileUrl captured', jane && jane.profileUrl === 'https://www.linkedin.com/in/janedoe', jane && jane.profileUrl);
    ok('dedup key is unique per person', w.__rosSN.keyish(recs[0]) !== w.__rosSN.keyish(recs[1]));
  }

  console.log('\n' + (fail === 0 ? '\x1b[32m' : '\x1b[31m') + '  ' + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
  process.exit(fail === 0 ? 0 : 1);
})();
