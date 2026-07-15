// Shared query builder for the LandlineDB search + export routes.
// Kept out of the route files because Next App Router route modules may only
// export route handlers and a fixed set of config values, not helpers.

export function buildLandlineQuery(p: URLSearchParams): { sql: string; params: unknown[]; countSql: string } {
  const where: string[] = ["r.phone_e164 IS NOT NULL"];
  const params: unknown[] = [];
  const add = (clause: string, v: unknown) => {
    params.push(v);
    where.push(clause.replace("?", "$" + params.length));
  };

  const q = (p.get("q") || "").trim();
  if (q) {
    if (/^\+?1?[\d\s().-]{10,}$/.test(q)) {
      const d = q.replace(/\D/g, "").replace(/^1/, "");
      add("r.phone_e164 = ?", "+1" + d);
    } else {
      params.push("%" + q.toLowerCase() + "%");
      const n = "$" + params.length;
      where.push(`(lower(r.company_name) LIKE ${n} OR lower(r.person_name) LIKE ${n} OR lower(r.dba_name) LIKE ${n})`);
    }
  }
  if (p.get("state")) add("r.state = ?", (p.get("state") || "").toUpperCase());
  if (p.get("source")) add("r.source_id = ?", p.get("source"));
  if (p.get("dial_class")) add("r.dial_class = ?", p.get("dial_class"));
  if (p.get("industry")) add("r.industry = ?", p.get("industry"));
  if (p.get("has_person") === "1") where.push("r.person_name IS NOT NULL");

  const w = where.join(" AND ");
  const cols = `r.id, r.source_id, r.company_name, r.dba_name, r.person_name, r.person_title,
    r.phone_e164, r.cell_e164, r.email, r.address1, r.city, r.state, r.zip,
    r.industry, r.dial_class, r.company_size_hint, r.retrieved_at`;
  return {
    sql: `SELECT ${cols} FROM records r WHERE ${w} ORDER BY r.id`,
    countSql: `SELECT count(*) AS n FROM records r WHERE ${w}`,
    params,
  };
}
