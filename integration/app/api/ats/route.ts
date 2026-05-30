/**
 * GET /api/ats -> ATS vendor catalog + the Loxo object mapping (settings screen).
 */

import { ATS_VENDORS, LOXO_OBJECT_MAP, getAts } from "../../../lib/ats";
import { requireSession, ok } from "../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  return ok({ vendors: ATS_VENDORS, objectMap: LOXO_OBJECT_MAP, active: getAts().vendor });
}
