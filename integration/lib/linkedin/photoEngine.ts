/**
 * Photo engine for the LinkedIn Poster: real, licensed photos for post media.
 *
 * Sources, in order of preference:
 *   1. Pexels    (PEXELS_API_KEY)  - curated professional stock, free API,
 *                                    license allows modification + commercial
 *                                    use, no attribution required.
 *   2. Openverse (keyless)         - CC-licensed photos aggregated from
 *                                    Flickr, Wikimedia and friends. Filtered
 *                                    to commercial-use licenses; attribution
 *                                    is baked onto the rendered image.
 *   3. Gemini    (GEMINI_API_KEY)  - optional AI-generated photograph, used
 *                                    only when no stock result fits.
 *
 * Every network call is time-boxed and every failure degrades to "no photos",
 * which the card renderer treats as "use the SVG looks": media never blocks a
 * draft.
 */

export interface StockPhoto {
  provider: "pexels" | "pixabay" | "openverse" | "wikimedia" | "ai";
  /** Provider-side id; used to dedupe and to re-resolve server-side. */
  providerId: string;
  /** Full-resolution download URL (server-side use only). */
  downloadUrl: string;
  /** Small preview for the picker grid. */
  thumbUrl: string;
  width: number | null;
  height: number | null;
  /** Photographer / creator display name when the provider gives one. */
  creator: string | null;
  /** Source page for the human "where is this from" link. */
  pageUrl: string | null;
  /** Credit line to bake onto composites (CC licenses); null = not required. */
  credit: string | null;
}

const SEARCH_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

const searchCache = new Map<string, { at: number; photos: StockPhoto[] }>();

/** Which photo sources are live right now (shown as a quiet status caption). */
export function photoProviders(): string[] {
  const p: string[] = [];
  if (process.env.PEXELS_API_KEY) p.push("Pexels");
  if (process.env.PIXABAY_API_KEY) p.push("Pixabay");
  p.push("Openverse", "Wikimedia");
  if (process.env.GEMINI_API_KEY) p.push("AI studio");
  return p;
}

async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

function normQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
}

/* --------------------------------- Pexels -------------------------------- */

async function searchPexels(query: string): Promise<StockPhoto[]> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return [];
  const u = new URL("https://api.pexels.com/v1/search");
  u.searchParams.set("query", query);
  u.searchParams.set("orientation", "portrait");
  u.searchParams.set("size", "large");
  u.searchParams.set("per_page", "24");
  const r = await timedFetch(u.toString(), { headers: { Authorization: key } });
  if (!r.ok) throw new Error(`pexels_${r.status}`);
  const j = (await r.json()) as { photos?: any[] };
  return (j.photos ?? [])
    .filter((p) => p?.src?.large2x && p?.id)
    .map((p): StockPhoto => ({
      provider: "pexels",
      providerId: String(p.id),
      downloadUrl: String(p.src.large2x),
      thumbUrl: String(p.src.medium ?? p.src.large2x),
      width: Number.isFinite(p.width) ? p.width : null,
      height: Number.isFinite(p.height) ? p.height : null,
      creator: typeof p.photographer === "string" ? p.photographer.slice(0, 60) : null,
      pageUrl: typeof p.url === "string" ? p.url : null,
      credit: null, // Pexels license: attribution not required
    }));
}

/* -------------------------------- Pixabay -------------------------------- */

async function searchPixabay(query: string): Promise<StockPhoto[]> {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return [];
  const u = new URL("https://pixabay.com/api/");
  u.searchParams.set("key", key);
  u.searchParams.set("q", query);
  u.searchParams.set("image_type", "photo");
  u.searchParams.set("min_width", "1000");
  u.searchParams.set("per_page", "25");
  u.searchParams.set("safesearch", "true");
  const r = await timedFetch(u.toString());
  if (!r.ok) throw new Error(`pixabay_${r.status}`);
  const j = (await r.json()) as { hits?: any[] };
  return (j.hits ?? [])
    .filter((p) => p?.id && p?.largeImageURL)
    .map((p): StockPhoto => ({
      provider: "pixabay",
      providerId: String(p.id),
      downloadUrl: String(p.largeImageURL),
      thumbUrl: String(p.webformatURL ?? p.largeImageURL),
      width: Number.isFinite(p.imageWidth) ? p.imageWidth : null,
      height: Number.isFinite(p.imageHeight) ? p.imageHeight : null,
      creator: typeof p.user === "string" ? p.user.slice(0, 60) : null,
      pageUrl: typeof p.pageURL === "string" ? p.pageURL : null,
      credit: null, // Pixabay Content License: attribution not required
    }));
}

/* --------------------------- Wikimedia Commons ---------------------------- */

/** Keyless and deep, with real hi-res files, but heavily archival: great for
 *  the manual photo search where a human curates, wrong for auto-attach (a
 *  1918 field hospital under a 2026 post). Only unrestricted licenses pass
 *  (CC0 / public domain / no known restrictions / CC BY); share-alike and
 *  no-derivative are skipped because rendered composites are derivatives. */
const WM_OK_LICENSE = /^(cc0|public domain|pd|no restrictions|cc by(?: \d\.\d)?)$/i;

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

async function searchWikimedia(query: string): Promise<StockPhoto[]> {
  const u = new URL("https://commons.wikimedia.org/w/api.php");
  u.searchParams.set("action", "query");
  u.searchParams.set("format", "json");
  u.searchParams.set("origin", "*");
  u.searchParams.set("generator", "search");
  u.searchParams.set("gsrsearch", query + " filetype:bitmap");
  u.searchParams.set("gsrnamespace", "6");
  u.searchParams.set("gsrlimit", "20");
  u.searchParams.set("prop", "imageinfo");
  u.searchParams.set("iiprop", "url|size|extmetadata");
  u.searchParams.set("iiurlwidth", "1600");
  const r = await timedFetch(u.toString(), {
    headers: { "User-Agent": "RecruitersOS/1.0 (post media; contact: ops@recruitersos.co)" },
  });
  if (!r.ok) throw new Error(`wikimedia_${r.status}`);
  const j = (await r.json()) as any;
  const pages: any[] = Object.values(j?.query?.pages ?? {});
  const out: StockPhoto[] = [];
  for (const pg of pages) {
    const ii = pg?.imageinfo?.[0];
    if (!ii?.thumburl || !ii?.width || !ii?.height) continue;
    // Newer API responses omit `url` when iiurlwidth is set; the thumburl
    // carries a utm query string, so test extension ahead of the `?`.
    if (!OV_OK_TYPES.test(String(ii.thumburl))) continue;
    const meta = ii.extmetadata ?? {};
    const license = stripHtml(String(meta.LicenseShortName?.value ?? ""));
    if (!WM_OK_LICENSE.test(license)) continue;
    const artist = stripHtml(String(meta.Artist?.value ?? "")).slice(0, 60) || null;
    const free = /^(cc0|public domain|pd|no restrictions)$/i.test(license);
    const thumb = String(ii.thumburl).replace(/\/\d+px-/, "/480px-");
    out.push({
      provider: "wikimedia",
      providerId: String(pg.pageid),
      downloadUrl: String(ii.thumburl), // server-rendered 1600px jpeg, not the 50MB original
      thumbUrl: thumb,
      width: Number(ii.width) || null,
      height: Number(ii.height) || null,
      creator: artist,
      pageUrl: typeof ii.descriptionurl === "string" ? ii.descriptionurl : null,
      credit: free ? null : `Photo: ${artist ?? "Wikimedia Commons"} (${license})`,
    });
  }
  return out;
}

/* -------------------------------- Openverse ------------------------------ */

const OV_OK_TYPES = /\.(jpe?g|png|webp)(\?|$)/i;

/** Openverse is keyless and anonymously rate-limited; a watch pull can fire
 *  several searches at once, so calls queue with a little daylight between. */
let ovChain: Promise<unknown> = Promise.resolve();
const OV_SPACING_MS = 1500;
function ovThrottled<T>(fn: () => Promise<T>): Promise<T> {
  const run = ovChain.then(fn, fn);
  ovChain = run.then(
    () => new Promise((r) => setTimeout(r, OV_SPACING_MS)),
    () => new Promise((r) => setTimeout(r, OV_SPACING_MS)),
  );
  return run;
}

const OV_STOPWORDS = new Set(["a", "an", "the", "of", "in", "at", "on", "and", "or", "with", "for", "to"]);

/** Openverse full-text relevance is loose (a "law firm meeting" query returns
 *  schools and houses); score results by how many of the query's real words
 *  their title (worth double) and tags actually carry. 0 = drop it. */
function ovMatchScore(query: string, title: string, tags: string[]): number {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2 && !OV_STOPWORDS.has(t));
  if (!tokens.length) return 1;
  const titleHay = title.toLowerCase();
  const tagHay = tags.join(" ").toLowerCase();
  let s = 0;
  for (const t of tokens) {
    if (titleHay.includes(t)) s += 2;
    else if (tagHay.includes(t)) s += 1;
  }
  return s;
}

async function searchOpenverse(query: string): Promise<StockPhoto[]> {
  const u = new URL("https://api.openverse.org/v1/images/");
  u.searchParams.set("q", query);
  // cc0/pdm/by only: commercial use AND derivatives allowed (our composites
  // are derivatives, so nd/sa licenses are out). The category and size
  // filters look tempting but their metadata is so sparse they empty the
  // result set; ranking below handles size instead.
  u.searchParams.set("license", "cc0,pdm,by");
  u.searchParams.set("per_page", "20");
  const r = await ovThrottled(() => timedFetch(u.toString(), {
    headers: { Accept: "application/json", "User-Agent": "RecruitersOS/1.0 (post media; contact: ops@recruitersos.co)" },
  }));
  if (!r.ok) throw new Error(`openverse_${r.status}`);
  const j = (await r.json()) as { results?: any[] };
  const scored = (j.results ?? [])
    .filter((p) => p?.id && typeof p.url === "string" &&
      (OV_OK_TYPES.test(p.url) || ["jpg", "jpeg", "png", "webp"].includes(String(p.filetype ?? "").toLowerCase())))
    .map((p) => ({
      p,
      rel: ovMatchScore(query, String(p.title ?? ""), Array.isArray(p.tags) ? p.tags.map((t: any) => String(t?.name ?? "")) : []),
    }))
    .filter((x) => x.rel > 0)
    .sort((a, b) => b.rel - a.rel);
  return scored
    .map(({ p }): StockPhoto => {
      const creator = typeof p.creator === "string" && p.creator.trim() ? p.creator.trim().slice(0, 60) : null;
      const lic = String(p.license ?? "").toUpperCase();
      const free = lic === "CC0" || lic === "PDM";
      return {
        provider: "openverse",
        providerId: String(p.id),
        downloadUrl: String(p.url),
        thumbUrl: typeof p.thumbnail === "string" ? p.thumbnail : String(p.url),
        width: Number.isFinite(p.width) ? p.width : null,
        height: Number.isFinite(p.height) ? p.height : null,
        creator,
        pageUrl: typeof p.foreign_landing_url === "string" ? p.foreign_landing_url : null,
        credit: free ? null : `Photo: ${creator ?? "unknown"} (CC ${lic.replace(/^CC[- ]?/, "")})`,
      };
    });
}

/* ------------------------------- search API ------------------------------ */

/** Portrait-friendly first: tall or safely croppable to 4:5 without zooming
 *  through the subject. Unknown sizes sink to the end rather than being lost. */
function rankPhotos(photos: StockPhoto[]): StockPhoto[] {
  const score = (p: StockPhoto): number => {
    if (!p.width || !p.height) return 1;
    if (p.width < 640 || p.height < 480) return 0; // too small for any look
    const ratio = p.height / p.width;
    let s = 1;
    if (ratio >= 1.1) s = 3; // already portrait
    else if (ratio >= 0.6) s = 2; // landscape but crops fine
    if (p.width >= 1200 && p.height >= 1200) s += 2; // full-bleed capable
    return s;
  };
  const ranked = [...photos].filter((p) => score(p) > 0).sort((a, b) => score(b) - score(a));
  // Same shot indexed twice (common on Openverse) and long runs from one
  // photographer both make variant cycling feel static: collapse exact
  // download URLs, then cap each creator at two appearances.
  const seenUrl = new Set<string>();
  const perCreator = new Map<string, number>();
  const out: StockPhoto[] = [];
  for (const p of ranked) {
    if (seenUrl.has(p.downloadUrl)) continue;
    seenUrl.add(p.downloadUrl);
    const c = p.creator ?? p.providerId;
    const n = perCreator.get(c) ?? 0;
    if (n >= 2) continue;
    perCreator.set(c, n + 1);
    out.push(p);
  }
  return out;
}

/**
 * Licensed photos for a query, best-first. Cached in memory for 6h so variant
 * cycling and repeated drafts on the same theme never re-hit the providers.
 *
 * `deep` widens the sweep to the archival sources (Wikimedia Commons) too:
 * right for the Media tab's human-curated search, wrong for auto-attach,
 * where a century-old archive scan under a fresh post would read as a miss.
 */
export async function searchStockPhotos(query: string, opts: { deep?: boolean } = {}): Promise<StockPhoto[]> {
  const q = normQuery(query);
  if (!q) return [];
  const key = (opts.deep ? "deep|" : "") + q;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.photos;
  // Keyed curated sources first, in parallel; the keyless archives join in
  // whenever the curated pool is thin. A provider that errors contributes
  // nothing rather than sinking the search.
  const settle = async (fns: (() => Promise<StockPhoto[]>)[]): Promise<StockPhoto[]> => {
    const r = await Promise.allSettled(fns.map((f) => f()));
    return r.flatMap((x) => (x.status === "fulfilled" ? x.value : []));
  };
  let photos = await settle([() => searchPexels(q), () => searchPixabay(q)]);
  if (photos.length < 8 || opts.deep) {
    const keyless: (() => Promise<StockPhoto[]>)[] = [() => searchOpenverse(q)];
    if (opts.deep) keyless.push(() => searchWikimedia(q));
    photos = photos.concat(await settle(keyless));
  }
  photos = rankPhotos(photos).slice(0, 24);
  searchCache.set(key, { at: Date.now(), photos });
  return photos;
}

/** Re-resolve a photo by provider id from the cached search (so the client
 *  never supplies a download URL: no server-side fetch of arbitrary hosts).
 *  Deep search, so anything the Media tab showed is resolvable. */
export async function resolveStockPhoto(query: string, provider: string, providerId: string): Promise<StockPhoto | null> {
  const photos = await searchStockPhotos(query, { deep: true });
  return photos.find((p) => p.provider === provider && p.providerId === providerId) ?? null;
}

/** Download the full-resolution bytes for a photo the engine selected. */
export async function fetchPhotoBytes(photo: StockPhoto): Promise<Buffer> {
  const r = await timedFetch(photo.downloadUrl, {
    headers: { "User-Agent": "RecruitersOS/1.0 (post media; contact: ops@recruitersos.co)" },
  });
  if (!r.ok) throw new Error(`photo_fetch_${r.status}`);
  const ab = await r.arrayBuffer();
  if (ab.byteLength < 10_000) throw new Error("photo_too_small");
  if (ab.byteLength > 25_000_000) throw new Error("photo_too_big");
  return Buffer.from(ab);
}

/* ----------------------------- AI generation ----------------------------- */

/**
 * Optional last rung: generate a photorealistic editorial image when stock
 * search comes back empty. Gated on GEMINI_API_KEY; any failure returns null.
 */
export async function generateAiPhoto(subject: string): Promise<Buffer | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const prompt =
      `Professional editorial photograph for a business publication: ${subject}. ` +
      `Natural light, candid, real workplace, shallow depth of field, vertical 4:5 composition. ` +
      `No text, no logos, no watermarks anywhere in the image.`;
    const r = await timedFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    const parts: any[] = j?.candidates?.[0]?.content?.parts ?? [];
    const img = parts.find((p) => p?.inlineData?.data && String(p.inlineData.mimeType ?? "").startsWith("image/"));
    if (!img) return null;
    const bytes = Buffer.from(String(img.inlineData.data), "base64");
    return bytes.length > 10_000 ? bytes : null;
  } catch {
    return null;
  }
}
