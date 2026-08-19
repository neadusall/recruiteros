import { readdirSync, readFileSync } from "node:fs";
const LUME = "ws_mqf6o989003", RYAN = "usr_mqf6o967002";
const files = readdirSync("/data").filter(x => /\.json$/.test(x));
const phones = new Set(), postals = new Set();
for (const f of files) {
  let s; try { s = JSON.parse(readFileSync("/data/" + f, "utf8")); } catch { continue; }
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    const isRyan = o.userId === RYAN || o.ownerId === RYAN || o.id === RYAN || /ryan\s*nead/i.test(o.name || o.ownerName || "");
    const num = o.phone || o.number || o.telnyxNumber || o.fromNumber || o.did || o.phoneNumber;
    if (isRyan && num && /^\+?\d[\d\-\s()]{7,}$/.test(String(num))) phones.add(String(num) + "  [" + f + "]");
    const isLume = o.workspaceId === LUME || o.id === LUME;
    const addr = o.postalAddress || o.mailingAddress || o.address || o.companyAddress;
    if (isLume && typeof addr === "string" && addr.length > 8) postals.add(addr + "  [" + f + "]");
    if (Array.isArray(o)) o.forEach(walk); else for (const v of Object.values(o)) walk(v);
  };
  walk(s);
}
console.log("RYAN PHONES:", phones.size ? [...phones].slice(0, 6).join(" | ") : "none found in /data");
console.log("LUME POSTAL:", postals.size ? [...postals].slice(0, 3).join(" | ") : "none found in /data");
