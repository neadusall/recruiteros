/* RecruiterOS · Auth client
 *
 * Talks to the real backend at /api/auth/*. This is a production product: there
 * is no demo mode and no fake session. On success it lands the user in their
 * Command Center (command.html). On failure it shows an honest error.
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
      localStorage.setItem("ros_session", auth.token || (auth.session && auth.session.token) || "");
      localStorage.setItem("ros_ctx", JSON.stringify(auth));
    } catch (e) {}
    say("Welcome, " + (auth.user ? auth.user.name : "") + ". Opening your command center...", "okk");
    setTimeout(function () { location.href = "/command"; }, 500);
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

  function offline() {
    say("Can't reach the server right now. Please check your connection and try again.", "err");
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = document.getElementById("email").value.trim();
    var password = pw ? pw.value : "";
    var name = document.getElementById("name") ? document.getElementById("name").value.trim() : "";

    if (!valid(email)) return say("Enter a valid work email.", "err");
    if (password.length < 8 && page === "signup") return say("Password needs at least 8 characters.", "err");

    submitBtn.disabled = true;

    // Joining via a team invite link (?invite=token) -> accept into that workspace.
    var invite = new URLSearchParams(location.search).get("invite");
    if (invite && page === "signup") {
      say("Joining your team...", "busy");
      var teamBase = (window.RECRUITEROS_API_BASE || "") + "/api/team/accept";
      fetch(teamBase, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token: invite, name: name, password: password }),
      }).then(function (r) {
        return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("http_" + r.status)); return d; });
      }).then(land).catch(handleErr);
      return;
    }

    say(page === "signup" ? "Creating your workspace..." : "Signing you in...", "busy");

    var req = page === "signup"
      ? api("/register", "POST", { email: email, password: password, name: name })
      : api("/login", "POST", { email: email, password: password });

    req.then(land).catch(handleErr);

    function handleErr(err) {
      if (/Failed to fetch|NetworkError/.test(String(err.message))) offline();
      else say(prettyErr(err.message), "err");
      submitBtn.disabled = false;
    }
  });

  if (magicBtn) {
    magicBtn.addEventListener("click", function () {
      var email = document.getElementById("email").value.trim();
      if (!valid(email)) return say("Enter your email first.", "err");
      magicBtn.disabled = true;
      say("Sending a magic link to " + email + "...", "busy");
      api("/magic-link", "POST", { email: email })
        .then(function () { say("Check your inbox for a one-time sign-in link.", "okk"); })
        .catch(function (err) {
          if (/Failed to fetch|NetworkError/.test(String(err.message))) offline();
          else say("Could not send the link. Please try again.", "err");
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

  // "Forgot?" -> the reset flow, prefilled with whatever email is typed.
  var forgot = document.getElementById("forgot");
  if (forgot) {
    forgot.addEventListener("click", function (e) {
      e.preventDefault();
      var emailEl = document.getElementById("email");
      var email = emailEl ? emailEl.value.trim() : "";
      location.href = valid(email) ? "forgot-password.html?email=" + encodeURIComponent(email) : "forgot-password.html";
    });
  }

  function prettyErr(code) {
    var map = {
      email_in_use: "That email already has an account. Try signing in.",
      invalid_credentials: "Email or password is incorrect.",
      weak_password: "Password needs at least 8 characters.",
      missing_fields: "Please fill in every field.",
      invalid_or_expired_invite: "That invite is invalid or expired.",
      already_member: "You're already on this team. Try signing in.",
    };
    return map[code] || "Something went wrong. Please try again.";
  }
})();
