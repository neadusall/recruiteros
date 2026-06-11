/* RecruiterOS · White-label theme
 * Re-skin the UI to a customer's accent color. The base CSS uses a violet/cyan
 * palette via --brand / --grad and a few hardcoded aurora blobs; a white-label
 * customer (e.g. Lume = teal #0080A0) needs ALL of it recolored, not just one
 * variable. Given a single accent we derive a small palette and override the
 * brand tokens + aurora globally. Idempotent: re-callable with a new accent.
 *
 * Exposed as window.__wlTheme(accent). No-op for falsy/invalid input. */
(function () {
  "use strict";
  function norm(hex) {
    hex = String(hex || "").trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(hex)) hex = hex.replace(/./g, function (c) { return c + c; });
    return /^[0-9a-fA-F]{6}$/.test(hex) ? hex : null;
  }
  function mix(hex, t) { // t: 0 -> color, 1 -> white
    var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    r = Math.round(r + (255 - r) * t); g = Math.round(g + (255 - g) * t); b = Math.round(b + (255 - b) * t);
    return "#" + [r, g, b].map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
  }
  window.__wlTheme = function (accent) {
    var h = norm(accent);
    if (!h) return;
    var c = "#" + h;
    var c2 = mix(h, 0.30);      // lighter accent for the gradient's far stop
    var t1 = mix(h, 0.55), t2 = mix(h, 0.80); // light tints for headline gradient-text
    var css =
      ":root{--brand:" + c + ";--brand-2:" + c2 + ";" +
      "--grad:linear-gradient(120deg," + c + " 0%," + c2 + " 100%);" +
      "--grad-text:linear-gradient(120deg," + t1 + " 0%," + t2 + " 60%," + c2 + " 100%);}" +
      ".aurora .b1{background:radial-gradient(circle," + c + ",transparent 70%)!important}" +
      ".aurora .b2{background:radial-gradient(circle," + c2 + ",transparent 70%)!important}" +
      ".aurora .b3{background:radial-gradient(circle," + c + ",transparent 70%)!important}";
    var el = document.getElementById("wl-theme");
    if (!el) { el = document.createElement("style"); el.id = "wl-theme"; document.head.appendChild(el); }
    el.textContent = css;
  };
})();
