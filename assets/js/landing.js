/* RecruiterOS, landing interactions + FX */
(function () {
  /* ---------- Scroll progress bar ---------- */
  const progress = document.createElement('div');
  progress.className = 'scroll-progress';
  document.body.appendChild(progress);

  /* ---------- Sticky nav shadow on scroll ---------- */
  const navEl = document.querySelector('.nav');
  function onScroll() {
    const st = window.scrollY || document.documentElement.scrollTop;
    if (navEl) navEl.classList.toggle('scrolled', st > 12);
    const docH = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.width = (docH > 0 ? (st / docH) * 100 : 0) + '%';
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
      window.location.href = 'command.html' + (q ? '?q=' + q : '');
    });
  }

  /* ---------- Hero particle constellation ---------- */
  const canvas = document.getElementById('fxCanvas');
  if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = canvas.getContext('2d');
  let w, h, dots, mouse = { x: -999, y: -999 };
  const COLORS = ['124,92,255', '77,208,255', '255,122,198'];

  function resize() {
    const r = canvas.getBoundingClientRect();
    w = canvas.width = r.width * devicePixelRatio;
    h = canvas.height = r.height * devicePixelRatio;
    const count = Math.min(90, Math.floor((r.width * r.height) / 14000));
    dots = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.25 * devicePixelRatio,
      vy: (Math.random() - 0.5) * 0.25 * devicePixelRatio,
      r: (Math.random() * 1.6 + 0.6) * devicePixelRatio,
      c: COLORS[(Math.random() * COLORS.length) | 0],
    }));
  }

  const section = canvas.closest('.hero');
  section.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = (e.clientX - r.left) * devicePixelRatio;
    mouse.y = (e.clientY - r.top) * devicePixelRatio;
  });
  section.addEventListener('mouseleave', () => { mouse.x = mouse.y = -9999; });

  function frame() {
    ctx.clearRect(0, 0, w, h);
    const linkDist = 130 * devicePixelRatio;
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      d.x += d.vx; d.y += d.vy;
      if (d.x < 0 || d.x > w) d.vx *= -1;
      if (d.y < 0 || d.y > h) d.vy *= -1;

      // gentle pull toward mouse
      const mdx = mouse.x - d.x, mdy = mouse.y - d.y;
      const md = Math.hypot(mdx, mdy);
      if (md < 160 * devicePixelRatio) { d.x += mdx * 0.012; d.y += mdy * 0.012; }

      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + d.c + ',0.9)';
      ctx.fill();

      for (let j = i + 1; j < dots.length; j++) {
        const o = dots[j];
        const dist = Math.hypot(d.x - o.x, d.y - o.y);
        if (dist < linkDist) {
          ctx.beginPath();
          ctx.moveTo(d.x, d.y); ctx.lineTo(o.x, o.y);
          ctx.strokeStyle = 'rgba(' + d.c + ',' + (0.16 * (1 - dist / linkDist)) + ')';
          ctx.lineWidth = devicePixelRatio;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener('resize', resize);
  frame();
})();
