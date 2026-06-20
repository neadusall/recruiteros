/**
 * GET /api/health -> liveness + a precise, RUNTIME view of durable persistence.
 *
 * IMPORTANT — `force-dynamic`. Without it, Next statically pre-renders this GET handler at
 * BUILD time, where /data isn't mounted and ROS_DATA_DIR isn't set yet, then serves that
 * baked-in result forever. That made the endpoint report dataDirMounted/hasDataDir = false
 * even though the RUNNING container was fully durable (it cost a long debugging chase). The
 * actual ground-truth signal `dbConnected` (a real write-probe) was correct the whole time.
 * force-dynamic evaluates every request inside the live container, so the flags match reality.
 */

import { statSync, readFileSync } from "fs";
import { dbEnabled, dbPing } from "../../../lib/db";
import { ok } from "../../../lib/api";

export const dynamic = "force-dynamic"; // never static-cache this — evaluate at runtime
export const revalidate = 0;

/** /data lives on a different device than "/" (a mounted named volume). */
function dataDirMounted(): boolean {
  try {
    return statSync("/data").dev !== statSync("/").dev;
  } catch {
    return false;
  }
}

/**
 * /data appears as its own mount in the kernel's mountinfo — the authoritative answer,
 * robust to storage drivers where a volume can share a device number with root. Checks the
 * process's own table AND falls back to PID 1's, so a namespace/standalone quirk can't
 * produce a false negative.
 */
function dataDirIsMountpoint(): boolean {
  const hasData = (mi: string) =>
    mi.split("\n").some((l) => {
      const mp = l.split(" ")[4]; // 5th field = mount point
      return mp === "/data" || (mp ? mp.startsWith("/data/") : false);
    });
  for (const p of ["/proc/self/mountinfo", "/proc/1/mountinfo"]) {
    try {
      if (hasData(readFileSync(p, "utf8"))) return true;
    } catch {
      /* try the next source */
    }
  }
  return false;
}

export async function GET() {
  const db = dbEnabled();
  const dbConnected = await dbPing();
  const mounted = dataDirMounted();
  const isMountpoint = dataDirIsMountpoint();
  // The one flag to trust: a working durable backend whose data dir is a real mount.
  // dbPing actually writes a probe file to the store, so it is the ground-truth signal;
  // the mount checks confirm that store survives a container rebuild.
  const durable = db && dbConnected && (mounted || isMountpoint);
  return ok({
    ok: true,
    ver: "h8-dynamic", // bump on deploy to confirm the container rebuilt
    durable, // <- authoritative: is persistence actually safe across redeploys?
    db,
    dbConnected,
    dataDirMounted: mounted,
    dataDirIsMountpoint: isMountpoint,
    hasDataDir: !!process.env.ROS_DATA_DIR,
    hasDbUrl: !!process.env.DATABASE_URL,
    hasPgPw: !!process.env.POSTGRES_PASSWORD,
  });
}
