/* RecruiterOS · White-label auth branding
 * On a customer's own domain, brand the login/signup screen with THEIR logo and
 * name before anyone signs in. Resolves /api/branding/resolve?host=<host> (public,
 * logo + name only) and swaps the .brand wordmark + page title. No-op on the
 * house domains (recruitersos.co / localhost) and on any failure. */
(function () {
  "use strict";
  try {
    var host = location.host || "";
    if (/(^|\.)recruitersos\.co$|localhost|127\.0\.0\.1|^$/.test(host)) return; // house host -> default brand
    var base = (window.RECRUITEROS_API_BASE || "") + "/api";
    fetch(base + "/branding/resolve?host=" + encodeURIComponent(host))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var b = d && d.branding;
        if (!b || (!b.logoUrl && !b.brandName && !b.accentColor)) return;
        var brand = document.querySelector(".brand");
        if (brand) {
          if (b.logoUrl) {
            brand.innerHTML = '<img src="' + b.logoUrl + '" alt="logo" style="max-height:36px;max-width:180px;object-fit:contain">';
          } else if (b.brandName) {
            brand.textContent = b.brandName;
          }
        }
        if (b.accentColor) document.documentElement.style.setProperty("--brand", b.accentColor);
        if (b.brandName) document.title = b.brandName;
      })
      .catch(function () {});
  } catch (e) {}
})();
