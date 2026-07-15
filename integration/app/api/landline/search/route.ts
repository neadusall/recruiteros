import { NextResponse } from "next/server";
import { landlineDb, guardLandline, corsHeaders, corsPreflight } from "../../../../lib/landline/db";
import { buildLandlineQuery } from "../../../../lib/landline/query";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(req: Request) {
  const g = guardLandline(req);
  if ("response" in g) return g.response;
  const p = new URL(req.url).searchParams;
  const limit = Math.min(parseInt(p.get("limit") || "50", 10) || 50, 500);
  const offset = Math.max(parseInt(p.get("offset") || "0", 10) || 0, 0);
  try {
    const { sql, countSql, params } = buildLandlineQuery(p);
    const db = landlineDb();
    const [rows, count] = await Promise.all([
      db.query(sql + ` LIMIT ${limit} OFFSET ${offset}`, params),
      db.query(countSql, params),
    ]);
    return NextResponse.json(
      { total: Number(count.rows[0]?.n || 0), limit, offset, rows: rows.rows },
      { headers: corsHeaders() },
    );
  } catch (e) {
    return NextResponse.json(
      { total: 0, rows: [], error: "query_failed" },
      { status: 200, headers: corsHeaders() },
    );
  }
}
