/* RecruiterOS · Password reset client
 *
 * Powers two pages:
 *   forgot-password.html -> request a reset link (POST /api/auth/reset)
 *   reset-password.html  -> validate ?token, set a new password (PUT /api/auth/reset)
 *
 * API-first with a demo fallback so the flow is fully clickable on the static
 * site (no backend). On success it lands in the Command Center.
 */
(function () {
  "use strict";

  var API = (window.RECRUITEROS_API_BASE || "") + "/api/auth";
  var forgotForm = document.getElementById("forgotForm");
  var resetForm = document.getElementById("resetForm");
  var msg = document.getElementById("msg");

  function say(text, kind) { msg.textContent = text; msg.className = "auth-msg" + (kind ? " " + kind : ""); }
  function valid(email) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email); }
  function qp(name) { return new URLSearchParams(location.search).get(name); }

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
      localStorage.setItem("ros_session", auth.token || (auth.session && auth.session.token) || "demo");
      localStorage.setItem("ros_ctx", JSON.stringify(auth));
    } catch (e) {}
    say("Password updated. Opening your command center...", "okk");
    setTimeout(function () { location.href = "command.html"; }, 600);
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
          if (/Failed to fetch|NetworkError|http_404/.test(String(err.message))) {
            // Demo: no backend, hand the user straight to the reset page.
            say("Reset link sent. (demo) Opening the reset page...", "okk");
            setTimeout(function () { location.href = "reset-password.html?token=demo&email=" + encodeURIComponent(email); }, 900);
          } else {
            say("Could not send the link. Please try again.", "err");
            btn.disabled = false;
          }
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
    var demo = token === "demo" || !token;

    if (!token) {
      say("This reset link is missing its token. Request a new one.", "err");
    } else if (!demo) {
      // Pre-validate the token so we can show the email / catch expiry early.
      fetch(API + "/reset?token=" + encodeURIComponent(token))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.valid) { say("This reset link is invalid or has expired.", "err"); }
          else if (d.email && forEmail) { forEmail.textContent = "For " + d.email; }
        })
        .catch(function () { /* offline: let the submit handle it */ });
    }
    var demoEmail = qp("email");
    if (demo && demoEmail && forEmail) forEmail.textContent = "For " + demoEmail;

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
      var btn = document.getElementById("submitBtn");
      btn.disabled = true;
      say("Saving your new password...", "busy");

      if (demo) {
        // No backend: synthesize a session so the flow completes.
        var email = demoEmail || "you@company.com";
        var domain = (email.split("@")[1] || "workspace").split(".")[0];
        land({
          token: "demo_" + Math.random().toString(36).slice(2),
          user: { id: "usr_demo", email: email, name: email.split("@")[0], emailVerified: true },
          workspace: { id: "ws_demo", name: domain.charAt(0).toUpperCase() + domain.slice(1), plan: "trial" },
          role: "owner", capabilities: null, demo: true,
        });
        return;
      }

      api("/reset", "PUT", { token: token, password: p1 })
        .then(land)
        .catch(function (err) {
          var m = String(err.message);
          say(/expired|invalid/.test(m) ? "This link is invalid or expired. Request a new one." : "Could not reset. Please try again.", "err");
          btn.disabled = false;
        });
    });
  }
})();
