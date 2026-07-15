import { guardLandline, landlineDb, corsHeaders, corsPreflight } from "../../../../lib/landline/db";
import { buildLandlineQuery } from "../../../../lib/landline/query";

export const dynamic = "force-dynamic";

const CAP = 100000;
const COLS = ["source_id","company_name","dba_name","person_name","person_title","phone_e164","cell_e164",
  "email","address1","city","state","zip","industry","dial_class","company_size_hint"] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(req: Request) {
  const g = guardLandline(req);
  if ("response" in g) return g.response;
  const p = new URL(req.url).searchParams;
  const { sql, params } = buildLandlineQuery(p);
  const db = landlineDb();
  const res = await db.query(sql + ` LIMIT ${CAP}`, params);
  const lines = [COLS.join(",")];
  for (const r of res.rows) lines.push(COLS.map((c) => csvCell((r as Record<string, unknown>)[c])).join(","));
  return new Response(lines.join("\n"), {
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="landlinedb-export.csv"`,
    },
  });
}
