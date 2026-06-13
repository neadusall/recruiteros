/* RecruitersOS · Password reset client
 *
 * Powers two pages against the real backend (no demo mode):
 *   forgot-password.html -> request a reset link (POST /api/auth/reset)
 *   reset-password.html  -> validate ?token, set a new password (PUT /api/auth/reset)
 *
 * On success it lands the user in their Command Center.
 */
(function () {
  "use strict";

  var API = (window.RECRUITEROS_API_BASE || "") + "/api/auth";
  var forgotForm = document.getElementById("forgotForm");
  var resetForm = document.getElementById("resetForm");
  var msg = document.getElementById("msg");
  if (!msg) return;

  function say(text, kind) { msg.textContent = text; msg.className = "auth-msg" + (kind ? " " + kind : ""); }
  function valid(email) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email); }
  function qp(name) { return new URLSearchParams(location.search).get(name); }
  function offline() { say("Can't reach the server right now. Please check your connection and try again.", "err"); }

  function api(path, method, payload) {
    return fetch(API + path, {
      method: method,
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: payload ? JSON.stringify(payload) : undefined,
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || ("http_" + r.status));
        return d;
      });
    });
  }

  function land(auth) {
    try {
      localStorage.setItem("ros_session", auth.token || (auth.session && auth.session.token) || "");
      localStorage.setItem("ros_ctx", JSON.stringify(auth));
    } catch (e) {}
    say("Password updated. Opening your command center...", "okk");
    setTimeout(function () { location.href = "/command"; }, 600);
  }

  /* ---------------- forgot-password.html ---------------- */
  if (forgotForm) {
    var emailEl = document.getElementById("email");
    var pre = qp("email");
    if (pre && emailEl) emailEl.value = pre;

    forgotForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = emailEl.value.trim();
      if (!valid(email)) return say("Enter a valid work email.", "err");
      var btn = document.getElementById("submitBtn");
      btn.disabled = true;
      say("Sending your reset link...", "busy");
      api("/reset", "POST", { email: email })
        .then(function () {
          say("If that email has an account, a reset link is on its way. Check your inbox.", "okk");
        })
        .catch(function (err) {
          if (/Failed to fetch|NetworkError/.test(String(err.message))) offline();
          else say("Could not send the link. Please try again.", "err");
          btn.disabled = false;
        });
    });
  }

  /* ---------------- reset-password.html ---------------- */
  if (resetForm) {
    var token = qp("token");
    var pw = document.getElementById("password");
    var confirm = document.getElementById("confirm");
    var strength = document.getElementById("strength");
    var forEmail = document.getElementById("forEmail");

    if (!token) {
      say("This reset link is missing its token. Request a new one.", "err");
    } else {
      // Pre-validate the token so we can show the email / catch expiry early.
      fetch(API + "/reset?token=" + encodeURIComponent(token))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.valid) { say("This reset link is invalid or has expired.", "err"); }
          else if (d.email && forEmail) { forEmail.textContent = "For " + d.email; }
        })
        .catch(function () { /* offline: the submit will surface it */ });
    }

    if (pw && strength) {
      pw.addEventListener("input", function () {
        var v = pw.value, score = 0;
        if (v.length >= 8) score++;
        if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
        if (/\d/.test(v) || /[^\w]/.test(v)) score++;
        strength.setAttribute("data-level", score <= 1 ? "weak" : score === 2 ? "ok" : "strong");
      });
    }

    resetForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var p1 = pw.value, p2 = confirm.value;
      if (p1.length < 8) return say("Password needs at least 8 characters.", "err");
      if (p1 !== p2) return say("Those passwords don't match.", "err");
      if (!token) return say("This reset link is missing its token. Request a new one.", "err");
      var btn = document.getElementById("submitBtn");
      btn.disabled = true;
      say("Saving your new password...", "busy");

      api("/reset", "PUT", { token: token, password: p1 })
        .then(land)
        .catch(function (err) {
          var m = String(err.message);
          if (/Failed to fetch|NetworkError/.test(m)) offline();
          else say(/expired|invalid/.test(m) ? "This link is invalid or expired. Request a new one." : "Could not reset. Please try again.", "err");
          btn.disabled = false;
        });
    });
  }
})();
