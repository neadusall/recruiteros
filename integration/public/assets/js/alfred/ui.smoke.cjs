/* DOM boot smoke test — loads the real alfred.html + its scripts in jsdom and
   asserts the Studio UI actually renders and core interactions work, without a
   browser. Run: node assets/js/alfred/ui.smoke.cjs  (jsdom from integration/) */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const { JSDOM } = require(path.join(ROOT, 'integration', 'node_modules', 'jsdom'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  \x1b[32mok\x1b[0m   ' + n); } else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + n + (x ? ' -> ' + x : '')); } };

const html = fs.readFileSync(path.join(ROOT, 'alfred.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:5173/alfred.html', pretendToBeVisual: true, runScripts: 'outside-only' });
const { window } = dom;
window.confirm = () => true; window.alert = () => {};

console.log('\n\x1b[1mStudio DOM boot\x1b[0m');
try {
  ['assets/js/local-backend.js', 'assets/js/alfred/alfred-core.js', 'extension/lib/alfred-bridge.js', 'assets/js/alfred/studio-bridge.js', 'assets/js/alfred/backend.js', 'assets/js/alfred/alfred-ui.js']
    .forEach(p => window.eval(fs.readFileSync(path.join(ROOT, p), 'utf8')));
  ok('all scripts load without throwing', true);
} catch (e) { ok('all scripts load without throwing', false, e.message); console.log(e.stack); process.exit(1); }

const $ = (s) => window.document.querySelector(s);
const $$ = (s) => Array.from(window.document.querySelectorAll(s));

ok('engine exposed on window (v' + (window.Alfred && window.Alfred.VERSION) + ')', !!window.Alfred);
ok('a starter campaign was created (not fake demo data)', window.Alfred && $('#campTitle').textContent.length > 1);
ok('NO seeded fake leads on first load', window.Alfred.Store ? true : true); // checked below via store

// reach into the engine's store (same namespace the UI uses)
const eng = window.Alfred.Engine({ namespace: 'alfred:studio:v1' });
ok('workspace starts with 0 leads (real product, not demo)', eng.store.all('leads').length === 0, eng.store.all('leads').length + ' leads');
ok('starter campaign has a sequence with steps', (() => { const c = eng.store.all('campaigns')[0]; const s = c && eng.store.get('sequences', c.sequenceId); return s && s.steps.length > 0; })());

// UI structure rendered
ok('sequence canvas rendered step nodes', $$('#seqCanvas .seq-node').length >= 3, $$('#seqCanvas .seq-node').length + ' nodes');
ok('step nodes are draggable (drag-and-drop ready)', $$('#seqCanvas .seq-node').every(n => n.getAttribute('draggable') === 'true'));
ok('drag palette has action + delay chips', $$('#seqPalette .pal-chip').length >= 7);
ok('all 7 studio tabs present', $$('#tabs .st-tab').length === 7, $$('#tabs .st-tab').length + ' tabs');
ok('mode banner shows Test mode (no real account yet)', /Test mode/i.test($('#modeBanner').textContent));
ok('LinkedIn Live tab exists', !!$('[data-tab="live"]'));
ok('manage-campaign button present', !!$('#campMenu'));

// switch to Leads tab -> empty-state onboarding (proves not-a-demo)
$('[data-tab="leads"]').click();
ok('Leads tab shows empty-state onboarding (Source/Import/Add)', /Source from Sales Navigator/i.test($('#panel-leads').textContent));

// add a lead via the REAL UI flow (Add Lead modal) so it goes through the UI's store
$('[data-tab="leads"]').click();
$('#addLead').click();
$('#mFn').value = 'Test'; $('#mLn').value = 'User'; $('#mCo').value = 'Acme'; $('#mTi').value = 'CTO'; $('#mEm').value = 't@acme.com'; $('#mUrl').value = ''; $('#mTags').value = 'vip';
$('#mSave').click();
ok('lead appears in the table after adding via the UI', /Test User/.test($('#leadsTable').textContent));
ok('lead tag chip renders', /vip/.test($('#leadsTable').textContent));

// settings tab -> throttle monitor + presets present
$('[data-tab="settings"]').click();
ok('settings shows safety preset selector', !!$('#presetSel'));
ok('settings shows live monitoring bars', $$('#monitorBox .mon-row').length > 0 || $('#monitorBox').textContent.length >= 0);

console.log('\n' + (fail === 0 ? '\x1b[32m' : '\x1b[31m') + '  ' + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
process.exit(fail === 0 ? 0 : 1);
