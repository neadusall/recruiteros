import { readdirSync, readFileSync } from "node:fs";
const RYAN = "usr_mqf6o967002";
for (const f of readdirSync("/data").filter(x => /\.json$/.test(x))) {
  let s; try { s = JSON.parse(readFileSync("/data/" + f, "utf8")); } catch { continue; }
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (o.id === RYAN || o.userId === RYAN) {
      const flat = {};
      for (const [k, v] of Object.entries(o)) if (typeof v === "string" || typeof v === "number") flat[k] = v;
      console.log("[" + f + "]", JSON.stringify(flat).slice(0, 500));
    }
    if (Array.isArray(o)) o.forEach(walk); else for (const v of Object.values(o)) walk(v);
  };
  walk(s);
}
