/* RecruitersOS, landing interactions.
   The FX era (scroll-progress bar, fxCanvas particles, aurora) is retired:
   those elements no longer exist in the markup, so nothing here creates or
   animates them. Every block below no-ops safely when its element is absent. */
(function () {
  /* ---------- Sticky nav shadow on scroll ---------- */
  const navEl = document.querySelector('.nav');
  function onScroll() {
    const st = window.scrollY || document.documentElement.scrollTop;
    if (navEl) navEl.classList.toggle('scrolled', st > 12);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- Mobile nav drawer (injected, no per-page HTML) ---------- */
  (function mobileNav() {
    const inner = document.querySelector('.nav .nav-inner');
    const links = document.querySelector('.nav .nav-links');
    if (!inner || !links) return;

    const toggle = document.createElement('button');
    toggle.className = 'nav-toggle';
    toggle.setAttribute('aria-label', 'Open menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<span></span><span></span><span></span>';
    inner.appendChild(toggle);

    const scrim = document.createElement('div');
    scrim.className = 'nav-scrim';
    document.body.appendChild(scrim);

    // Mirror the header CTAs into the drawer so mobile users can act.
    const cta = document.querySelector('.nav .nav-cta');
    if (cta && !links.querySelector('.nav-mobile-cta')) {
      const wrap = document.createElement('div');
      wrap.className = 'nav-mobile-cta';
      wrap.innerHTML = cta.innerHTML;
      links.appendChild(wrap);
    }

    function setOpen(open) {
      document.body.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }
    toggle.addEventListener('click', () => setOpen(!document.body.classList.contains('nav-open')));
    scrim.addEventListener('click', () => setOpen(false));
    links.addEventListener('click', (e) => { if (e.target.tagName === 'A') setOpen(false); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
    window.addEventListener('resize', () => { if (window.innerWidth > 980) setOpen(false); });
  })();

  /* ---------- Active page in the header nav ---------- */
  (function activeNav() {
    const path = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
    document.querySelectorAll('.nav .nav-links > a, .nav .nav-links .has-drop > a').forEach((a) => {
      const href = (a.getAttribute('href') || '').replace(/\.html$/, '').replace(/\/$/, '') || '/';
      if (href !== '/' && href === path) a.setAttribute('aria-current', 'page');
    });
  })();

  /* ---------- Reveal-on-scroll ---------- */
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          if (e.target.classList.contains('stats')) animateCounts();
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12 }
  );
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

  /* ---------- Animated counters ---------- */
  function animateCounts() {
    document.querySelectorAll('[data-count]').forEach((el) => {
      const target = parseFloat(el.dataset.count);
      const suffix = el.dataset.suffix || '';
      const dur = 1100;
      const start = performance.now();
      function tick(now) {
        const p = Math.min((now - start) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(eased * target) + suffix;
        if (p < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  /* ---------- Hero chips fill the search box ---------- */
  const input = document.getElementById('heroQuery');
  document.querySelectorAll('#heroChips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (input) { input.value = chip.textContent.trim(); input.focus(); }
    });
  });

  /* ---------- Hero search -> hand query to the app ---------- */
  const form = document.getElementById('heroSearch');
  if (form && input) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = encodeURIComponent(input.value.trim());
      window.location.href = '/command' + (q ? '?q=' + q : '');
    });
  }
})();
