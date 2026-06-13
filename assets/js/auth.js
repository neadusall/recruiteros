/* RecruitersOS · Auth client
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
  var pendingChallenge = null; // set when a 2FA code is awaited

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

  // Land in the right portal. A recruiter (role "member", e.g. someone who just
  // accepted an invite) goes to the Recruiter Portal; an admin/owner goes to the
  // Admin Portal. The portal pages are the same app, scoped by role.
  function land(auth, forcePortal) {
    var portal = forcePortal || (auth && auth.role === "member" ? "recruiter" : "admin");
    try {
      localStorage.setItem("ros_session", auth.token || (auth.session && auth.session.token) || "");
      localStorage.setItem("ros_ctx", JSON.stringify(auth));
      localStorage.setItem("ros_portal", portal);
    } catch (e) {}
    var dest = portal === "recruiter" ? "/recruiter" : "/admin";
    // De-facto white-label onboarding: a brand-new admin signup lands straight on
    // the Branding setup so making the portal theirs is the first thing they do.
    var freshAdminSignup = page === "signup" && portal === "admin";
    if (freshAdminSignup) {
      try { localStorage.setItem("ros_onboard", "1"); } catch (e) {}
      dest = "/admin#setup/branding";
    }
    say("Welcome, " + (auth.user ? auth.user.name : "") + ". " +
      (freshAdminSignup ? "Let's make the portal yours..." : "Opening your " +
        (portal === "recruiter" ? "Recruiter" : "Admin") + " Portal..."), "okk");
    setTimeout(function () { location.href = dest; }, 500);
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

  // Second step of a 2FA sign-in: the password was accepted and we're holding a
  // challenge; this submit carries the authenticator (or recovery) code.
  function showTwoFactor(challenge) {
    pendingChallenge = challenge;
    form.querySelectorAll("label.fld").forEach(function (l) { l.style.display = "none"; });
    [".or", ".btn-li", ".auth-fine"].forEach(function (sel) {
      var el = document.querySelector(sel); if (el) el.style.display = "none";
    });
    if (magicBtn) magicBtn.style.display = "none";
    var title = document.getElementById("title"); if (title) title.textContent = "Two-factor verification";
    var sub = document.querySelector(".auth-sub"); if (sub) sub.textContent = "Open your authenticator app and enter the 6-digit code.";
    var wrap = document.createElement("label");
    wrap.className = "fld";
    wrap.innerHTML = '<span>Authentication code</span><input id="twoFactorCode" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" required />';
    form.insertBefore(wrap, submitBtn);
    submitBtn.textContent = "Verify →";
    submitBtn.disabled = false;
    say("Lost your device? Enter one of your backup recovery codes instead.", "");
    var codeEl = document.getElementById("twoFactorCode"); if (codeEl) codeEl.focus();
  }

  function onAuthResult(d) {
    if (d && d.twoFactorRequired) return showTwoFactor(d.challenge);
    land(d);
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    // 2FA step: redeem the challenge with the code instead of email/password.
    if (pendingChallenge) {
      var codeEl = document.getElementById("twoFactorCode");
      var code = codeEl ? codeEl.value.trim() : "";
      if (!code) return say("Enter your authentication code.", "err");
      submitBtn.disabled = true;
      say("Verifying...", "busy");
      api("/2fa/login", "POST", { challenge: pendingChallenge, code: code })
        .then(land)
        .catch(function (err) {
          if (/Failed to fetch|NetworkError/.test(String(err.message))) offline();
          else say(prettyErr(err.message), "err");
          submitBtn.disabled = false;
        });
      return;
    }

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
      }).then(function (auth) {
        // Invited users land in the portal their role implies (recruiters ->
        // Recruiter Portal; an invited admin -> Admin Portal).
        land(auth, auth && auth.role === "admin" ? "admin" : "recruiter");
      }).catch(handleErr);
      return;
    }

    say(page === "signup" ? "Creating your workspace..." : "Signing you in...", "busy");

    var req = page === "signup"
      ? api("/register", "POST", { email: email, password: password, name: name })
      : api("/login", "POST", { email: email, password: password });

    req.then(onAuthResult).catch(handleErr);

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

  // Show an error passed back from OAuth (e.g. ?error=linkedin_bad_state).
  var oauthErr = new URLSearchParams(location.search).get("error");
  if (oauthErr) {
    var msgMap = {
      linkedin_not_configured: "LinkedIn sign-in isn't set up yet. Use email for now.",
      linkedin_bad_state: "LinkedIn sign-in expired. Please try again.",
      linkedin_token_failed: "LinkedIn sign-in failed. Please try again.",
      linkedin_profile_failed: "Could not read your LinkedIn profile. Try email sign-in.",
      linkedin_no_code: "LinkedIn sign-in was cancelled.",
    };
    say(msgMap[oauthErr] || "Sign-in failed. Please try again.", "err");
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
      invalid_code: "That code isn't right. Check your authenticator app and try again.",
      challenge_expired: "This sign-in timed out. Please enter your password again.",
    };
    return map[code] || "Something went wrong. Please try again.";
  }
})();
