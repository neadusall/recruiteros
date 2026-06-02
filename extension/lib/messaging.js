/* ============================================================
   Shared message protocol — the integration contract.
   Loaded in BOTH content scripts (window) and the service
   worker (self, via importScripts). Every layer agrees on these
   message types, so a host outreach tool can talk to the
   extension without reading any other file.
   ============================================================ */
(function (g) {
  'use strict';

  const TYPE = {
    // host page / popup -> background
    PING:            'ros.ping',
    GET_STATE:       'ros.getState',
    UPDATE_SETTINGS: 'ros.updateSettings',
    CONNECT_ACCOUNT: 'ros.connectAccount',   // detect the logged-in LinkedIn user
    SET_LIVE:        'ros.setLive',          // { live:boolean } real actions on/off
    ENQUEUE:         'ros.enqueue',
    ENQUEUE_BATCH:   'ros.enqueueBatch',
    SET_RUNNING:     'ros.setRunning',
    CLEAR_QUEUE:     'ros.clearQueue',
    TEST_ACTION:     'ros.testAction',       // run one action on the active tab now

    // scraping (Sales Navigator)
    SCRAPE_START:    'ros.scrapeStart',      // { url, maxPages, name } start a job
    SCRAPE_PAGE:     'ros.scrapePage',       // content -> bg: one page of records
    SCRAPE_PROGRESS: 'ros.scrapeProgress',   // bg -> popup (via state)
    SCRAPE_STOP:     'ros.scrapeStop',
    GET_DATASETS:    'ros.getDatasets',      // -> [{id,name,count,...}]
    GET_DATASET:     'ros.getDataset',       // { id } -> full records
    DELETE_DATASET:  'ros.deleteDataset',    // { id }
    EXPORT_CSV:      'ros.exportCsv',        // { id } -> triggers a download
    DATASET_TO_CAMPAIGN: 'ros.datasetToCampaign', // { id, campaignName }

    // background -> content (active LinkedIn tab)
    GET_IDENTITY:    'ros.getIdentity',      // -> { name, publicId, ... }
    SCRAPE_THIS:     'ros.scrapeThis',       // scrape the search page the tab is on
    SCRAPE_ONE_PAGE: 'ros.scrapeOnePage',    // dry-run: scrape current page only
    DO_ACTION:       'ros.doAction',         // { action } -> ActionResult

    // content -> background (events)
    CAPTURE_LEAD:    'ros.captureLead',
    IDENTITY:        'ros.identity',
    BRIDGE_EVENT:    'ros.bridgeEvent',     // observed accept/reply -> forward to bridge
    LOG:             'ros.log',
  };

  const CHANNEL = 'linkedin';
  const ACTION = {
    VIEW: 'view', FOLLOW: 'follow', ENDORSE: 'endorse',
    CONNECT: 'connect', MESSAGE: 'message', INMAIL: 'inmail', LIKE: 'like',
  };

  // Columns a scraped Sales Nav person carries (and the CSV header order).
  const LEAD_FIELDS = ['fullName', 'firstName', 'lastName', 'headline', 'title', 'company', 'location', 'profileUrl', 'salesNavUrl', 'connectionDegree', 'datasetName', 'capturedAt'];

  function makeAction(type, target, payload, meta) {
    return {
      id: 'act_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
      type, channel: CHANNEL,
      target: target || {}, payload: payload || {}, meta: meta || {},
      status: 'queued', createdAt: Date.now(),
    };
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res);
        });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  }

  /* ---- data cleaning (shared by the scraper + CSV export) ---- */

  // Normalize a scraped display name to a clean "First Last": drop leading
  // honorifics, cut at the first comma / pipe / paren / dash / symbol, strip
  // emojis, and drop trailing credentials (MBA, PhD, Jr, …). Multi-word surnames
  // that are all letters (e.g. "Van Der Berg") are kept.
  function cleanName(raw) {
    if (!raw) return { full: '', first: '', last: '' };
    var s = String(raw).split(/\s[–—-]\s|[,|/()•·@]/u)[0];
    s = s.replace(/[^\p{L}\p{M}.'’\- ]/gu, ' ').replace(/\s+/g, ' ').trim();
    var words = s.split(' ').filter(Boolean);
    var HON = /^(dr|mr|mrs|ms|miss|mx|prof|sir|madam)\.?$/i;
    while (words.length && HON.test(words[0])) words.shift();
    var SUF = /^(jr|sr|ii|iii|iv|phd|md|mba|cpa|cfa|esq|pmp|rn|do|jd|msc|bsc|ba|bs|ma|mph|dds|md)\.?$/i;
    while (words.length > 1 && SUF.test(words[words.length - 1])) words.pop();
    var first = words[0] || '';
    var last = words.slice(1).join(' ');
    return { full: (first + (last ? ' ' + last : '')).trim(), first: first, last: last };
  }

  // Strip emojis / decorative symbols from free text (headline, title, company,
  // location) while keeping normal words + everyday punctuation.
  function cleanText(raw) {
    if (!raw) return '';
    return String(raw)
      .replace(/[^\p{L}\p{M}\p{N}.,&/()'’"+:#@%\- ]/gu, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([,.])/g, '$1')
      .trim();
  }

  // Company name: de-junk, then strip trailing legal suffixes (Inc, LLC, Ltd, …)
  // and any trailing commas. "Globex, Inc." -> "Globex", "Acme LLC" -> "Acme".
  function cleanCompany(raw) {
    var s = cleanText(raw);
    var re = /[\s,]+(?:inc|llc|l\.l\.c|ltd|limited|corp|corporation|gmbh|plc|pllc|llp|lp|ag|s\.?a|bv|nv|pty|srl|oy|ab|kg|spa)\.?$/i;
    for (var i = 0; i < 3 && re.test(s); i++) s = s.replace(re, '').replace(/[\s,]+$/, '');
    return s.trim();
  }

  // Normalize a public LinkedIn profile URL to https://www.linkedin.com/in/<slug>.
  function publicProfileUrl(href) {
    if (!href) return '';
    var m = String(href).match(/linkedin\.com\/in\/([^/?#]+)/i) || String(href).match(/\/in\/([^/?#]+)/i);
    return m ? 'https://www.linkedin.com/in/' + m[1] : '';
  }

  g.ROS = { TYPE, ACTION, CHANNEL, LEAD_FIELDS, makeAction, send, cleanName, cleanText, cleanCompany, publicProfileUrl, VERSION: '0.3.0' };
})(typeof self !== 'undefined' ? self : this);
