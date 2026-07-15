import { NextResponse } from "next/server";
import { landlineDb, guardLandline, corsHeaders, corsPreflight } from "../../../../lib/landline/db";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(req: Request) {
  const g = guardLandline(req);
  if ("response" in g) return g.response;
  try {
    const db = landlineDb();
    const [totals, bySource, byClass, byState] = await Promise.all([
      db.query(`SELECT
          (SELECT count(*) FROM records) AS records,
          (SELECT count(*) FROM phones) AS unique_phones,
          (SELECT count(*) FROM records WHERE person_name IS NOT NULL AND phone_e164 IS NOT NULL) AS person_linked,
          (SELECT count(*) FROM records WHERE cell_e164 IS NOT NULL) AS cells`),
      db.query(`SELECT s.source_id, s.source_name, s.record_count, s.last_ingest_at
                FROM sources s ORDER BY s.record_count DESC`),
      db.query(`SELECT dial_class, count(*) n FROM records WHERE phone_e164 IS NOT NULL GROUP BY dial_class ORDER BY n DESC`),
      db.query(`SELECT state, count(*) n FROM records WHERE phone_e164 IS NOT NULL AND state IS NOT NULL
                GROUP BY state ORDER BY n DESC LIMIT 60`),
    ]);
    return NextResponse.json(
      { totals: totals.rows[0], sources: bySource.rows, dialClasses: byClass.rows, states: byState.rows },
      { headers: corsHeaders() },
    );
  } catch {
    return NextResponse.json(
      { totals: null, sources: [], dialClasses: [], states: [], setup: "database not initialized yet" },
      { status: 200, headers: corsHeaders() },
    );
  }
}
