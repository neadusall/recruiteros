// Lume Search Partners — site interactions (no dependencies)

// Mobile nav
(function () {
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.querySelector('.nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () { nav.classList.toggle('open'); });
    nav.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () { nav.classList.remove('open'); });
    });
  }
})();

// Jobs board: filter by category + live search
(function () {
  var grid = document.querySelector('.jobs-grid');
  if (!grid) return;
  var cards = Array.prototype.slice.call(grid.querySelectorAll('.job-card'));
  var filters = Array.prototype.slice.call(document.querySelectorAll('.filter'));
  var search = document.querySelector('.search');
  var empty = document.querySelector('.jobs-empty');
  var active = 'All';

  function apply() {
    var q = (search && search.value ? search.value : '').trim().toLowerCase();
    var shown = 0;
    cards.forEach(function (card) {
      var cat = card.getAttribute('data-category') || '';
      var text = (card.getAttribute('data-search') || '').toLowerCase();
      var matchCat = active === 'All' || cat === active;
      var matchText = !q || text.indexOf(q) !== -1;
      var show = matchCat && matchText;
      card.style.display = show ? '' : 'none';
      if (show) shown++;
    });
    if (empty) empty.style.display = shown === 0 ? 'block' : 'none';
  }
  filters.forEach(function (f) {
    f.addEventListener('click', function () {
      filters.forEach(function (x) { x.classList.remove('active'); });
      f.classList.add('active');
      active = f.getAttribute('data-filter');
      apply();
    });
  });
  if (search) search.addEventListener('input', apply);
})();

// Forms: Web3Forms when an access key is present, else mailto fallback
(function () {
  var forms = Array.prototype.slice.call(document.querySelectorAll('form[data-lume-form]'));
  forms.forEach(function (form) {
    var status = form.querySelector('.form__status');
    var key = form.getAttribute('data-web3forms') || '';
    var to = form.getAttribute('data-email') || 'info@lumesp.com';

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new FormData(form);

      // Fallback: no provider key configured -> open the visitor's mail client
      if (!key) {
        var subject = encodeURIComponent(form.getAttribute('data-subject') || 'Inquiry via lumesp.com');
        var lines = [];
        data.forEach(function (v, k) { if (v) lines.push(k + ': ' + v); });
        window.location.href = 'mailto:' + to + '?subject=' + subject +
          '&body=' + encodeURIComponent(lines.join('\n'));
        if (status) { status.className = 'form__status ok'; status.textContent = 'Opening your email app…'; }
        return;
      }

      // Real delivery via Web3Forms
      data.append('access_key', key);
      if (status) { status.className = 'form__status'; status.textContent = ''; }
      var btn = form.querySelector('button[type=submit]');
      if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Sending…'; }

      fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: data
      }).then(function (r) { return r.json(); }).then(function (json) {
        if (json.success) {
          form.reset();
          if (status) { status.className = 'form__status ok'; status.textContent = 'Thank you — your message has been sent.'; }
        } else {
          if (status) { status.className = 'form__status err'; status.textContent = 'Something went wrong. Please email ' + to + '.'; }
        }
      }).catch(function () {
        if (status) { status.className = 'form__status err'; status.textContent = 'Network error. Please email ' + to + '.'; }
      }).finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Send'; }
      });
    });
  });
})();

// Footer year
(function () {
  var el = document.querySelector('[data-year]');
  if (el) el.textContent = new Date().getFullYear();
})();
