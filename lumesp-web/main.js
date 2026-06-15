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

// Forms: applications + inquiries are delivered to our own jobs backend
// (/api/apply) so every submission is captured and shows up in the team portal.
// If the request fails (network/server down), we fall back to the visitor's
// email client so a submission is never silently lost.
window.LumeForms = (function () {
  function deriveTitle(form) {
    if (form.dataset.jobTitle) return form.dataset.jobTitle;
    var subj = form.getAttribute('data-subject') || '';
    if (subj.indexOf('Application: ') === 0) return subj.slice('Application: '.length);
    return subj || 'General inquiry';
  }

  function mailtoFallback(form, data, status) {
    var to = form.getAttribute('data-email') || 'info@lumesp.com';
    var subject = encodeURIComponent(form.getAttribute('data-subject') || 'Inquiry via lumesp.com');
    var lines = [];
    data.forEach(function (v, k) { if (v) lines.push(k + ': ' + v); });
    window.location.href = 'mailto:' + to + '?subject=' + subject + '&body=' + encodeURIComponent(lines.join('\n'));
    if (status) { status.className = 'form__status ok'; status.textContent = 'Opening your email app…'; }
  }

  function bind(form) {
    if (!form || form.dataset.lumeBound) return;
    form.dataset.lumeBound = '1';
    var status = form.querySelector('.form__status');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var payload = {
        jobId: form.dataset.jobId || '',
        jobTitle: deriveTitle(form),
        name: fd.get('name') || '',
        email: fd.get('email') || '',
        company: fd.get('company') || '',
        phone: fd.get('phone') || '',
        message: fd.get('message') || '',
        source: location.pathname
      };
      if (status) { status.className = 'form__status'; status.textContent = ''; }
      var btn = form.querySelector('button[type=submit]');
      if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Sending…'; }

      fetch('/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (r) {
        if (!r.ok) throw new Error('bad status');
        return r.json();
      }).then(function () {
        form.reset();
        if (status) { status.className = 'form__status ok'; status.textContent = 'Thank you — your message has been sent. We\'ll be in touch within one business day.'; }
      }).catch(function () {
        // Backend unreachable — don't lose the submission.
        mailtoFallback(form, fd, status);
      }).finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Send'; }
      });
    });
  }

  // Auto-bind every form already in the DOM.
  document.addEventListener('DOMContentLoaded', function () {
    Array.prototype.forEach.call(document.querySelectorAll('form[data-lume-form]'), bind);
  });

  return { bind: bind };
})();

// Footer year
(function () {
  var el = document.querySelector('[data-year]');
  if (el) el.textContent = new Date().getFullYear();
})();
