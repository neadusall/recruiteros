/* RecruitersOS · Session bridge
 * Runs before command.js. If there's no local ctx (e.g. the user just signed in
 * with LinkedIn and only has the HttpOnly session cookie), fetch the session
 * from the API and store it, so the portal boots without bouncing to login.
 * Blocks command.js only long enough to hydrate. */
(function () {
  "use strict";
  var API = (window.RECRUITEROS_API_BASE || "") + "/api";
  var hasCtx = false;
  try { hasCtx = !!JSON.parse(localStorage.getItem("ros_ctx") || "null"); } catch (e) {}
  if (hasCtx) return; // already have it, command.js proceeds normally

  // Synchronously block boot with a tiny loader, then hydrate from the cookie.
  document.documentElement.style.visibility = "hidden";
  var done = false;
  var xhr = new XMLHttpRequest();
  xhr.open("GET", API + "/auth/session", false); // sync: we must resolve before command.js reads localStorage
  xhr.withCredentials = true;
  try {
    xhr.send();
    if (xhr.status === 200) {
      var auth = JSON.parse(xhr.responseText);
      localStorage.setItem("ros_ctx", JSON.stringify(auth));
      localStorage.setItem("ros_session", (auth.session && auth.session.token) || auth.token || "");
      done = true;
    }
  } catch (e) {}
  document.documentElement.style.visibility = "";
  if (!done) { location.replace("/login"); }
})();
