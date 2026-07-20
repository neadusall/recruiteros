/**
 * RecruitersOS · JD Sourcing · phone-source slugs (the phone-accuracy metric).
 *
 * Every rung that puts a phone on a candidate stamps `phoneSource` with one of
 * these slugs. The slug rides into OS Text as customFields.phone_source, where
 * send/response outcomes (Telnyx cell check, delivery, replies, wrong-number
 * replies) are tallied per source, so "how accurate are the skip-trace numbers"
 * is a measured metric instead of a feeling.
 */

/** Canonical slugs, in the order the UI lists them. */
export const PHONE_SOURCES = ["skiptrace", "koldinfo", "laxis", "landlinedb", "finder"] as const;
export type PhoneSource = (typeof PHONE_SOURCES)[number];

/** Recruiter-facing labels (shared wording with the Outbound Performance card). */
export const PHONE_SOURCE_LABELS: Record<string, string> = {
  skiptrace: "Boost (skip trace)",
  koldinfo: "KoldInfo",
  laxis: "Laxis",
  landlinedb: "In-house phone DB",
  finder: "Phone finder",
  unknown: "Unknown source",
};

/** Waterfall providerId -> phone-source slug (undefined = not a phone rung we track). */
export function sourceFromProviderId(providerId?: string): string | undefined {
  switch (providerId) {
    case "rapidapi_skiptrace": return "skiptrace";
    case "rapidapi_mobile":
    case "rapidapi_phone": return "finder";
    default: return undefined;
  }
}
