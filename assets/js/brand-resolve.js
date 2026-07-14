/* RecruitersOS · White-label auth branding
 * On a customer's own domain, brand the login/signup screen with THEIR logo,
 * name, accent and favicon BEFORE anyone signs in, and never leak the house
 * brand. Resolves /api/branding/resolve?host=<host> (public; logo + name only).
 * No-op on the house domains (recruitersos.co / localhost).
 *
 * Anti-flash: a tiny inline guard in the page <head> hides the default wordmark
 * and neutralises the title on a non-house host (class "wl-hide" on <html>); this
 * script reveals it again the instant branding is applied (or on any failure, so
 * the page never stays blank). */
(function () {
  "use strict";
  function reveal() { try { document.documentElement.classList.remove("wl-hide"); } catch (e) {} }
  function isHouse(host) { return /(^|\.)recruitersos\.co$|localhost|127\.0\.0\.1|^$/.test(host); }
  try {
    var host = location.host || "";
    if (isHouse(host)) { reveal(); return; }
    var base = (window.RECRUITEROS_API_BASE || "") + "/api";
    fetch(base + "/branding/resolve?host=" + encodeURIComponent(host))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var b = d && d.branding;
        if (!b || (!b.logoUrl && !b.brandName && !b.accentColor)) return;
        // Meridian is light-first: pages that want the dark skin set
        // data-theme="dark" explicitly, so no attribute means light.
        var theme = document.documentElement.getAttribute("data-theme") || "light";
        var logo = theme === "light" ? (b.logoLightUrl || b.logoUrl) : (b.logoUrl || b.logoLightUrl);
        var scale = parseFloat(b.logoScale);
        if (!isFinite(scale) || scale <= 0) scale = 1;
        scale = Math.min(2.5, Math.max(0.5, scale));
        var logoH = Math.round(52 * scale);
        var alt = String(b.brandName || "logo").replace(/"/g, "&quot;");
        var brands = document.querySelectorAll(".brand");
        Array.prototype.forEach.call(brands, function (brand) {
          if (logo) {
            brand.innerHTML = '<img src="' + logo + '" alt="' + alt +
              '" style="display:block;height:' + logoH + 'px;max-width:280px;object-fit:contain;object-position:left center">';
          } else if (b.brandName) {
            brand.textContent = b.brandName;
          }
        });
        if (b.accentColor) {
          document.documentElement.style.setProperty("--brand", b.accentColor);
          if (window.__wlTheme) window.__wlTheme(b.accentColor); // recolor buttons/aurora/gradients
        }
        if (b.brandName) document.title = b.brandName;
        var favHref = b.faviconUrl || logo;
        if (favHref) {
          var fav = document.querySelector('link[rel="icon"]');
          if (!fav) { fav = document.createElement("link"); fav.rel = "icon"; document.head.appendChild(fav); }
          fav.setAttribute("href", favHref);
        }
      })
      .catch(function () {})
      .then(reveal); // always reveal (success or failure), never leave the brand hidden
  } catch (e) { reveal(); }
})();
