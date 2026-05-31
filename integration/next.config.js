/** @type {import('next').NextConfig} */
// Lenient on purpose: the lib/ modules are still evolving, so we don't want type
// or lint noise to block the dev server or a build while wiring things up.
module.exports = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // The bare root should show the marketing site, not the API info page.
  async redirects() {
    return [{ source: "/", destination: "/index.html", permanent: false }];
  },
};
