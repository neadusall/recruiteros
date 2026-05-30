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
    while (Date.now() - start < (timeoutMs || 15000)) {
      if (document.querySelectorAll(SEL.name).length > 0) { await sleep(500); return true; }
      // nudge lazy-loaded lists
      window.scrollTo(0, document.body.scrollHeight * 0.6);
      await sleep(500);
    }
    return document.querySelectorAll(SEL.name).length > 0;
  }

  /* ---- scrape every person on the current page ---- */
  function scrapeCurrentPage(datasetName) {
    const out = [];
    document.querySelectorAll(SEL.name).forEach((nameEl) => {
      const card = nameEl.closest(SEL.resultItem) || nameEl.closest('li') || nameEl.parentElement;
      if (!card) return;
      const fullName = nameEl.textContent.replace(/\s+/g, ' ').trim();
      if (!fullName) return;
      const [firstName, ...rest] = fullName.split(' ');
      const leadA = card.querySelector(SEL.leadLink);
      const pubA = card.querySelector(SEL.publicLink);
      const title = txt(card, SEL.title);
      out.push({
        fullName, firstName, lastName: rest.join(' '),
        headline: title, title,
        company: txt(card, SEL.company),
        location: txt(card, SEL.location),
        connectionDegree: txt(card, SEL.degree),
        salesNavUrl: leadA ? leadA.href.split('?')[0] : '',
        profileUrl: pubA ? pubA.href.split('?')[0] : '',
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

    banner('⏳ Scraping page ' + page + ' / ' + scrapeJob.maxPages + ' · ' + (scrapeJob.total || 0) + ' leads so far');
    const ok = await waitForResults();
    if (!ok) {
      banner('⚠ No results detected on this page. Stopping.');
      await send({ type: TYPE.SCRAPE_STOP });
      setTimeout(clearBanner, 4000);
      return;
    }

    const records = scrapeCurrentPage(scrapeJob.name);
    await send({ type: TYPE.SCRAPE_PAGE, datasetId: scrapeJob.datasetId, page, records });

    const more = hasNextPage();
    const reachedMax = page >= scrapeJob.maxPages;
    banner('✓ Page ' + page + ': +' + records.length + ' leads · ' + ((scrapeJob.total || 0) + records.length) + ' total');

    if (records.length && more && !reachedMax) {
      await sleep(jitter(scrapeJob.delayMin || 1200, scrapeJob.delayMax || 3200));
      location.href = urlForPage(scrapeJob.baseUrl, page + 1); // reload -> resumeJob() runs again
    } else {
      await send({ type: TYPE.SCRAPE_STOP, finished: true });
      banner('✅ Done. ' + ((scrapeJob.total || 0) + records.length) + ' leads captured. Open the extension to export CSV.');
      setTimeout(clearBanner, 8000);
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
