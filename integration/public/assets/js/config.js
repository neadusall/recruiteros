/* RecruitersOS · Frontend config
 *
 * Sets the backend API base for the portal pages. Empty string = same origin,
 * which is correct when the Next.js app (integration/) serves these pages or a
 * reverse proxy maps /api to it. To point the static marketing site at a
 * separately hosted API, set this to the full origin, e.g.
 *   window.RECRUITEROS_API_BASE = "https://app.recruitersos.co";
 *
 * This is a real, production product: there is no demo mode. Every account is a
 * real account created against the backend.
 */
window.RECRUITEROS_API_BASE = window.RECRUITEROS_API_BASE || "";
