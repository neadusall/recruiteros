export default function Home() {
  const groups: { base: string; routes: string[] }[] = [
    { base: "/api/auth", routes: ["register", "login", "magic-link", "session"] },
    { base: "/api/accounts", routes: ["GET/POST LinkedIn accounts, domains, keys"] },
    { base: "/api/campaigns", routes: ["GET/POST", "cadence"] },
    { base: "/api/prospects", routes: ["GET/POST (single, bulk, transition)"] },
    { base: "/api/linkedin", routes: ["enroll", "actions", "cron", "webhook"] },
    { base: "/api/response", routes: ["list", "actions", "webhook/[source]"] },
    { base: "/api/connected · /api/overview · /api/ats · /api/content", routes: [] },
  ];
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 28 }}>RecruiterOS Backend</h1>
      <p style={{ color: "#a3a3b8" }}>
        Team API for the LinkedIn engine, campaigns, prospects, response inbox, and auth.
        See <code>BACKEND.md</code> and <code>../INTEGRATION.md</code>.
      </p>
      <div style={{ display: "grid", gap: 10, marginTop: 24 }}>
        {groups.map((g) => (
          <div key={g.base} style={{ background: "#16161f", border: "1px solid rgba(255,255,255,.08)", borderRadius: 12, padding: 14 }}>
            <code style={{ color: "#8be7ff" }}>{g.base}</code>
            {g.routes.length > 0 && <span style={{ color: "#6c6c82", fontSize: 13 }}> — {g.routes.join(" · ")}</span>}
          </div>
        ))}
      </div>
    </main>
  );
}
