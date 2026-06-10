/** @type {import('next').NextConfig} */
// Lenient on purpose: the lib/ modules are still evolving, so we don't want type
// or lint noise to block the dev server or a build while wiring things up.

// Every static page in public/ (without the .html). Clean URLs map to these.
const PAGES = [
  "about", "alfred", "analytics", "app", "business-development-os",
  "campaign-builder", "campaign-studio", "command", "conversations",
  "developers", "features", "forgot-password", "helpcenter", "index", "integrations",
  "linkedin", "login", "outreach", "owner-console", "owner-login", "platform", "pricing",
  "recruiting-os", "reset-password", "signals", "signup", "sourcing", "text",
];

module.exports = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },

  // Run instrumentation.ts on server boot (Next 14 needs this flag) so the Hire Signals
  // background accumulator self-starts every deploy without waiting for a first request.
  // instrumentation.ts guards its node-only import behind NEXT_RUNTIME === "nodejs", so the
  // edge compile dead-code-eliminates it (no pg / node:crypto in the edge bundle).
  experimental: { instrumentationHook: true },

  // Serve clean URLs: /login renders public/login.html, address bar stays clean.
  async rewrites() {
    const pageRewrites = PAGES.filter((p) => p !== "index").map((p) => ({
      source: `/${p}`,
      destination: `/${p}.html`,
    }));
    // /home is the clean homepage URL.
    pageRewrites.push({ source: "/home", destination: "/index.html" });
    // Admin & Recruiter portals are the SAME app (command.html), scoped by role.
    // command.js reads the URL path to decide which portal to render, so both
    // clean URLs serve the one file.
    pageRewrites.push({ source: "/admin", destination: "/command.html" });
    pageRewrites.push({ source: "/recruiter", destination: "/command.html" });
    return pageRewrites;
  },

  // Bounce the old .html URLs (and bare root) to the clean path, so links that
  // still say /login.html land on /login. 301 so search engines learn the clean URL.
  async redirects() {
    const htmlRedirects = PAGES.filter((p) => p !== "index").map((p) => ({
      source: `/${p}.html`,
      destination: `/${p}`,
      permanent: true,
    }));
    return [
      { source: "/", destination: "/home", permanent: false },
      { source: "/index.html", destination: "/home", permanent: true },
      // The Help Center now lives at /helpcenter; forward the legacy /help URL.
      { source: "/help", destination: "/helpcenter", permanent: true },
      { source: "/help.html", destination: "/helpcenter", permanent: true },
      ...htmlRedirects,
    ];
  },
};
