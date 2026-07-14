/* RecruitersOS · White-label theme
 * Re-skin the UI to a customer's accent color. The Meridian design system is
 * token-driven: given a single accent we derive the small brand palette and
 * override the brand tokens globally. Gradients are retired, so the legacy
 * --grad/--grad-text tokens resolve to flat brand color. Idempotent:
 * re-callable with a new accent.
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
  function rgba(hex, a) {
    var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    return "rgba(" + r + ", " + g + ", " + b + ", " + a + ")";
  }
  window.__wlTheme = function (accent) {
    var h = norm(accent);
    if (!h) return;
    var c = "#" + h;
    var c2 = mix(h, 0.30); // lighter companion accent
    var css =
      ":root{--brand:" + c + ";--brand-2:" + c2 + ";" +
      "--brand-soft:" + rgba(h, 0.09) + ";" +
      "--accent:" + c + ";" +
      "--focus-ring:0 0 0 3px " + rgba(h, 0.18) + ";" +
      "--grad:linear-gradient(120deg," + c + " 0%," + c + " 100%);" +
      "--grad-text:linear-gradient(120deg," + c + " 0%," + c + " 100%);}" +
      "html[data-theme=\"dark\"]{--brand-soft:" + rgba(h, 0.16) + ";}";
    var el = document.getElementById("wl-theme");
    if (!el) { el = document.createElement("style"); el.id = "wl-theme"; document.head.appendChild(el); }
    el.textContent = css;
  };
})();
