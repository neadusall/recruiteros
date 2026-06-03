/* ============================================================
   Sales Navigator scraper (content script).
   Paginates a Sales Nav people-search and pulls each person into
   a stored dataset (the "database"), which the popup exports as CSV
   or turns into a campaign.

   Resume-safe: the active job lives in chrome.storage, each page is
   scraped idempotently, and pages advance via the `page` URL param —
   so even a full reload picks up exactly where it left off.

   Selectors target Sales Navigator's stable data-anonymize hooks.
   If LinkedIn changes the markup, update SEL in one place.
   ============================================================ */
(function () {
  'use strict';
  if (!window.ROS) return;
  const { TYPE, send } = window.ROS;

  const SEL = {
    resultItem: 'li.artdeco-list__item, li[class*="result-item"], div[class*="result-lockup"]',
    name: '[data-anonymize="person-name"]',
    title: '[data-anonymize="title"]',
    company: '[data-anonymize="company-name"]',
    location: '[data-anonymize="location"]',
    degree: '[data-anonymize="degree"], .artdeco-entity-lockup__degree',
    photo: 'img[data-anonymize="entity-photo"], .artdeco-entity-lockup__image img, .presence-entity__image, img.ember-view[src*="profile-displayphoto"], img[src*="media.licdn.com"]',
    leadLink: 'a[href*="/sales/lead/"]',
    publicLink: 'a[href*="/in/"]',
    nextBtn: 'button[aria-label="Next"]',
    totalCount: '.artdeco-pagination__page-state, [data-anonymize="search-result-count"]',
  };

  const isSearchPage = () => /\/sales\/search\/people/.test(location.pathname + location.search) || /\/sales\/search\/people/.test(location.href);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const txt = (root, sel) => { const e = root.querySelector(sel); return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; };
  const jitter = (a, b) => a + Math.random() * (b - a);

  function pageOf(url) {
    const m = /[?&]page=(\d+)/.exec(url); return m ? +m[1] : 1;
  }
  function urlForPage(url, page) {
    if (/[?&]page=\d+/.test(url)) return url.replace(/([?&]page=)\d+/, '$1' + page);
    return url + (url.includes('?') ? '&' : '?') + 'page=' + page;
  }

  /* ---- wait until the result cards have actually rendered ---- */
  async function waitForResults(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < (timeoutMs || 20000)) {
      if (document.querySelectorAll(SEL.name).length > 0) { await sleep(700); return true; }
      // nudge lazy-loaded lists
      window.scrollTo(0, document.body.scrollHeight * 0.6);
      await sleep(700);
    }
    return document.querySelectorAll(SEL.name).length > 0;
  }

  /* ---- the scrollable results container (Sales Nav virtualizes the list) ---- */
  function resultsContainer() {
    var el = document.querySelector(SEL.name);
    while (el && el !== document.body) {
      var s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 40) return el;
      el = el.parentElement;
    }
    return null;
  }

  /* ---- scrape a page progressively WHILE scrolling ----
     Sales Navigator VIRTUALIZES the list: as you scroll down, off-screen cards are
     removed from the DOM (only ~10-15 exist at once). So "scroll then scrape" only
     ever sees a fraction — the real cause of grabbing 43 of 304. Instead we crawl
     down slowly and capture cards as they render, deduping, until we hit the bottom
     with nothing new. This gets EVERY lead and reads like a human skimming. */
  function keyish(r) { return ((r.profileUrl || r.salesNavUrl || ((r.fullName || '') + '|' + (r.company || ''))) + '').toLowerCase(); }
  async function scrapePageProgressively(datasetName, onCount) {
    var map = new Map();
    function collect() {
      scrapeCurrentPage(datasetName).forEach(function (r) {
        var k = keyish(r); if (k && k !== '|' && !map.has(k)) map.set(k, r);
      });
      if (onCount) onCount(map.size);
    }
    // Pull the LAST rendered card into view each step. scrollIntoView scrolls
    // whatever element actually contains the list, so this works no matter how
    // Sales Nav nests/virtualizes it — and we collect before AND after each scroll
    // so cards are captured before they recycle out of the DOM.
    var prevSize = -1, stable = 0;
    for (var i = 0; i < 120 && stable < 4; i++) {
      collect();
      var cards = document.querySelectorAll(SEL.name);
      var last = cards.length ? (cards[cards.length - 1].closest(SEL.resultItem) || cards[cards.length - 1]) : null;
      try { if (last && last.scrollIntoView) last.scrollIntoView({ block: 'center' }); } catch (e) {}
      var box = resultsContainer();
      if (box) box.scrollTop = box.scrollHeight; else window.scrollTo(0, document.body.scrollHeight);
      await sleep(jitter(650, 1400));   // let the next batch render before recycling
      collect();
      if (map.size === prevSize) stable++; else stable = 0;
      prevSize = map.size;
    }
    // ease back to the top (human) and final sweep
    try { window.scrollTo(0, 0); } catch (e) {}
    await sleep(jitter(400, 800));
    collect();
    return Array.from(map.values());
  }

  /* ---- human dwell: stay on the page 20–50s (randomized), reading + scrolling,
     with an occasional longer "distracted" pause, before turning the page ---- */
  async function humanDwell(minMs, maxMs, onTick) {
    var total = jitter(minMs || 20000, maxMs || 50000);
    var roll = Math.random();
    if (roll < 0.07) total += jitter(60000, 150000);        // occasional "coffee break" (1–2.5 min)
    else if (roll < 0.22) total += jitter(8000, 18000);     // or just linger a bit longer
    var start = Date.now();
    var box = resultsContainer();
    while (Date.now() - start < total) {
      var remain = total - (Date.now() - start);
      if (onTick) onTick(Math.ceil(remain / 1000));
      await sleep(Math.min(jitter(2500, 6000), Math.max(250, remain)));
      // gentle, randomized scroll up/down — like skimming the results
      var delta = Math.round(window.innerHeight * (0.15 + Math.random() * 0.5)) * (Math.random() < 0.5 ? 1 : -1);
      if (box) box.scrollTop = Math.max(0, box.scrollTop + delta); else window.scrollBy(0, delta);
    }
  }

  /* ---- scrape every person on the current page ---- */
  function scrapeCurrentPage(datasetName) {
    const out = [];
    document.querySelectorAll(SEL.name).forEach((nameEl) => {
      const card = nameEl.closest(SEL.resultItem) || nameEl.closest('li') || nameEl.parentElement;
      if (!card) return;
      const rawName = nameEl.textContent.replace(/\s+/g, ' ').trim();
      if (!rawName) return;
      const nm = window.ROS.cleanName(rawName);   // "First Last", emojis/credentials stripped
      const leadA = card.querySelector(SEL.leadLink);
      const title = txt(card, SEL.title);
      const photoEl = card.querySelector(SEL.photo);
      const photoUrl = photoEl ? (photoEl.getAttribute('src') || photoEl.getAttribute('data-delayed-url') || '') : '';
      // Public profile URL: scan every anchor in the card for a /in/ link (the
      // person-name link, the photo link, or a hidden one), normalized.
      let profileUrl = '';
      const anchors = card.querySelectorAll('a[href]');
      for (let i = 0; i < anchors.length; i++) {
        const u = window.ROS.publicProfileUrl(anchors[i].getAttribute('href') || anchors[i].href);
        if (u) { profileUrl = u; break; }
      }
      out.push({
        fullName: nm.full || rawName, firstName: nm.first, lastName: nm.last,
        headline: window.ROS.cleanText(title), title: window.ROS.cleanText(title),
        company: window.ROS.cleanCompany(txt(card, SEL.company)),
        location: window.ROS.cleanText(txt(card, SEL.location)),
        photoUrl,
        connectionDegree: txt(card, SEL.degree),
        salesNavUrl: leadA ? leadA.href.split('?')[0] : '',
        profileUrl: profileUrl,
        datasetName: datasetName || '',
        source: 'sales-navigator',
        capturedAt: Date.now(),
      });
    });
    return out;
  }

  function hasNextPage() {
    const btn = document.querySelector(SEL.nextBtn);
    return !!btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
  }

  // Best-effort read of the search's total result count (for the done-summary
  // reconciliation). Returns 0 if it can't be parsed (no false warnings then).
  function totalResults() {
    var el = document.querySelector(SEL.totalCount);
    var txt = el ? el.textContent : '';
    var m = /of\s+([\d,]+)/i.exec(txt || '') || /([\d,]{2,})\s*(results|leads)/i.exec(txt || '');
    if (m) return parseInt(m[1].replace(/,/g, ''), 10) || 0;
    return 0;
  }

  // Merge two capture passes, deduped by the same key the dataset uses.
  function mergeByKey(a, b) {
    var m = {};
    (a || []).concat(b || []).forEach(function (r) { var k = keyish(r); if (k && k !== '|') m[k] = r; });
    return Object.keys(m).map(function (k) { return m[k]; });
  }

  /* ---- progress banner injected on the page ---- */
  function banner(html) {
    let b = document.getElementById('ros-scrape-banner');
    if (!b) {
      b = document.createElement('div'); b.id = 'ros-scrape-banner';
      b.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483000;background:#16161f;color:#f4f4f8;border:1px solid rgba(255,255,255,.16);border-radius:24px;padding:9px 18px;font:600 13px -apple-system,Segoe UI,sans-serif;box-shadow:0 10px 30px -8px rgba(0,0,0,.6)';
      document.body.appendChild(b);
    }
    b.innerHTML = html;
    return b;
  }
  function clearBanner() { const b = document.getElementById('ros-scrape-banner'); if (b) b.remove(); }

  /* ---- the resumable driver ---- */
  async function resumeJob() {
    if (!isSearchPage()) return;
    const { scrapeJob } = await chrome.storage.local.get('scrapeJob');
    if (!scrapeJob || scrapeJob.status !== 'running') return;

    const page = pageOf(location.href);
    if ((scrapeJob.scrapedPages || []).includes(page)) return; // already did this page

    banner('⏳ Loading page ' + page + ' / ' + scrapeJob.maxPages + ' · ' + (scrapeJob.total || 0) + ' leads so far');
    const ok = await waitForResults();
    if (!ok) {
      banner('⚠ No results on this page — reached the end. Done.');
      await send({ type: TYPE.SCRAPE_STOP, finished: true });
      setTimeout(clearBanner, 6000);
      return;
    }

    // Crawl the whole page slowly, capturing cards as they render (the list is
    // virtualized, so we must scrape while scrolling, not after).
    const onCount = function (n) { banner('🔎 Reading page ' + page + ' · ' + n + ' captured on this page…'); };
    let records = await scrapePageProgressively(scrapeJob.name, onCount);

    const more = hasNextPage();
    const reachedMax = page >= scrapeJob.maxPages;

    // FAIL-SAFE: never page on from a thin page when more pages exist. A full Sales
    // Nav page is ~25; if we got noticeably fewer AND there's a next page, the lower
    // cards just didn't render in time — re-crawl (from the top) and merge, up to
    // twice, before moving on. (The last page is legitimately allowed to be short.)
    const FULL_PAGE = 20;
    let retries = 0;
    while (records.length < FULL_PAGE && more && retries < 2) {
      banner('↻ Page ' + page + ' looked light (' + records.length + ') — double-checking before moving on…');
      const box = resultsContainer(); if (box) box.scrollTop = 0;
      try { window.scrollTo(0, 0); } catch (e) {}
      await sleep(jitter(1400, 2800));
      records = mergeByKey(records, await scrapePageProgressively(scrapeJob.name, onCount));
      retries++;
    }

    await send({ type: TYPE.SCRAPE_PAGE, datasetId: scrapeJob.datasetId, page, records });
    banner('✓ Page ' + page + ': +' + records.length + ' leads · ' + ((scrapeJob.total || 0) + records.length) + ' total');

    // Continue while there IS a next page and we're under the cap — do NOT stop just
    // because one page rendered thin (that early-stop is what capped runs at ~43).
    if (more && !reachedMax) {
      await humanDwell(scrapeJob.delayMin || 20000, scrapeJob.delayMax || 50000, function (s) {
        banner('✓ Page ' + page + ' done (' + ((scrapeJob.total || 0) + records.length) + ' total) · ⏳ pausing ' + s + 's (human pacing)…');
      });
      location.href = urlForPage(scrapeJob.baseUrl, page + 1); // reload -> resumeJob() runs again
    } else {
      await send({ type: TYPE.SCRAPE_STOP, finished: true });
      const captured = (scrapeJob.total || 0) + records.length;
      const expected = totalResults();
      // Reconcile against the search's reported total — warn (don't hide) if short,
      // and tell the user re-running is safe (duplicates are skipped).
      if (reachedMax && more) {
        banner('✅ Stopped at the ' + scrapeJob.maxPages + '-page cap · ' + captured + ' leads. Raise "Max pages" to go further.');
      } else if (expected && captured < Math.floor(expected * 0.9)) {
        banner('⚠ Done, but captured ' + captured + ' of ~' + expected + '. Some didn’t load — re-run the same search to catch the rest (dupes are skipped).');
      } else {
        banner('✅ Done. ' + captured + ' leads captured' + (expected ? ' of ~' + expected : '') + '. They’re in Prospects (and exportable as CSV).');
      }
      setTimeout(clearBanner, 12000);
    }
  }

  /* ---- direct messages from background (dry-run / on-demand) ---- */
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === TYPE.SCRAPE_ONE_PAGE) {
      (async () => {
        if (!isSearchPage()) return reply({ ok: false, info: 'Not on a Sales Navigator people-search page' });
        await waitForResults();
        const records = scrapeCurrentPage(msg.name || 'sample');
        reply({ ok: true, count: records.length, sample: records.slice(0, 5), records });
      })();
      return true;
    }
    if (msg.type === TYPE.SCRAPE_THIS) { resumeJob(); reply({ ok: true }); return true; }
    return false;
  });

  // auto-resume on every load of a search page
  if (document.readyState === 'complete') resumeJob();
  else window.addEventListener('load', resumeJob);
})();
