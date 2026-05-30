/* RecruiterOS · Auth client
 *
 * Talks to the integration backend at /api/auth/* when one is reachable, and
 * falls back to a local demo (localStorage) so the flow is fully clickable on
 * the static site. On success it lands in the Command Center (command.html).
 */
(function () {
  "use strict";

  var API = (window.RECRUITEROS_API_BASE || "") + "/api/auth";
  var page = document.body.classList.contains("auth-body") ? (document.getElementById("name") ? "signup" : "login") : null;
  var form = document.getElementById("authForm");
  if (!form) return;

  var msg = document.getElementById("msg");
  var submitBtn = document.getElementById("submitBtn");
  var magicBtn = document.getElementById("magicBtn");
  var pw = document.getElementById("password");
  var strength = document.getElementById("strength");

  function say(text, kind) {
    msg.textContent = text;
    msg.className = "auth-msg" + (kind ? " " + kind : "");
  }
  function valid(email) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email); }

  // password strength meter (signup)
  if (pw && strength) {
    pw.addEventListener("input", function () {
      var v = pw.value, score = 0;
      if (v.length >= 8) score++;
      if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
      if (/\d/.test(v) || /[^\w]/.test(v)) score++;
      strength.setAttribute("data-level", score <= 1 ? "weak" : score === 2 ? "ok" : "strong");
    });
  }

  function land(auth) {
    try {
      localStorage.setItem("ros_session", auth.token || (auth.session && auth.session.token) || "demo");
      localStorage.setItem("ros_ctx", JSON.stringify(auth));
    } catch (e) {}
    say("Welcome, " + (auth.user ? auth.user.name : "") + ". Opening your command center...", "okk");
    setTimeout(function () { location.href = "command.html"; }, 500);
  }

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

  // Local demo fallback when no backend is deployed.
  function demoAuth(email, name) {
    var domain = (email.split("@")[1] || "workspace").split(".")[0];
    return {
      token: "demo_" + Math.random().toString(36).slice(2),
      user: { id: "usr_demo", email: email, name: name || email.split("@")[0], emailVerified: false },
      workspace: { id: "ws_demo", name: domain.charAt(0).toUpperCase() + domain.slice(1), plan: "trial" },
      role: "owner",
      demo: true,
    };
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = document.getElementById("email").value.trim();
    var password = pw ? pw.value : "";
    var name = document.getElementById("name") ? document.getElementById("name").value.trim() : "";

    if (!valid(email)) return say("Enter a valid work email.", "err");
    if (password.length < 8 && page === "signup") return say("Password needs at least 8 characters.", "err");

    submitBtn.disabled = true;
    say(page === "signup" ? "Creating your workspace..." : "Signing you in...", "busy");

    var req = page === "signup"
      ? api("/register", "POST", { email: email, password: password, name: name })
      : api("/login", "POST", { email: email, password: password });

    req.then(land).catch(function (err) {
      // Backend not reachable on the static site -> demo flow.
      if (/Failed to fetch|NetworkError|http_404/.test(String(err.message))) {
        land(demoAuth(email, name));
      } else {
        say(prettyErr(err.message), "err");
        submitBtn.disabled = false;
      }
    });
  });

  if (magicBtn) {
    magicBtn.addEventListener("click", function () {
      var email = document.getElementById("email").value.trim();
      if (!valid(email)) return say("Enter your email first.", "err");
      magicBtn.disabled = true;
      say("Sending a magic link to " + email + "...", "busy");
      api("/magic-link", "POST", { email: email })
        .then(function () { say("Check your inbox for a one-time sign-in link.", "okk"); })
        .catch(function () {
          // Demo: pretend we sent it, then land after a beat.
          say("Magic link sent. (demo) Opening command center...", "okk");
          setTimeout(function () { land(demoAuth(email, "")); }, 800);
        })
        .finally(function () { magicBtn.disabled = false; });
    });
  }

  // Consume ?token=... magic links landing back on login.html
  var token = new URLSearchParams(location.search).get("token");
  if (token && page === "login") {
    say("Verifying your link...", "busy");
    api("/magic-link", "PUT", { token: token }).then(land).catch(function () {
      say("That link is invalid or expired.", "err");
    });
  }

  function prettyErr(code) {
    var map = {
      email_in_use: "That email already has an account. Try signing in.",
      invalid_credentials: "Email or password is incorrect.",
      weak_password: "Password needs at least 8 characters.",
      missing_fields: "Please fill in every field.",
    };
    return map[code] || "Something went wrong. Please try again.";
  }
})();
