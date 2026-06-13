/**
 * RecruitersOS · Public API
 * Machine-readable OpenAPI 3.1 description.
 *
 * Serve this at `/v1/openapi.json` so integrators can generate typed clients, import the
 * API into Postman/Insomnia, or wire it into an LLM tool spec. Keeping it here (next to
 * the router) makes "integrate your application seamlessly" literal: the contract is
 * discoverable and self-documenting.
 *
 * Returned as a plain object; stringify when serving.
 */

export const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "RecruitersOS Signal & Enrichment API",
    version: "1.0.0",
    description:
      "Find companies that are hiring and the hiring managers behind the roles, then " +
      "enrich them cheapest-source-first. Authenticate with a Bearer API key.",
  },
  servers: [{ url: "https://api.recruitersos.co" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "API key as rk_live_<id>.<secret>" },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              details: {},
            },
            required: ["code", "message"],
          },
        },
      },
      ICP: {
        type: "object",
        description: "Ideal Customer/Candidate Profile used to score signals.",
        properties: {
          id: { type: "string" },
          motion: { type: "string", enum: ["recruiting", "business_dev"] },
          industries: { type: "array", items: { type: "string" } },
          geos: { type: "array", items: { type: "string" } },
          titles: { type: "array", items: { type: "string" } },
          autoTriggerThreshold: { type: "number" },
        },
        required: ["id", "motion"],
      },
      Subject: {
        type: "object",
        description: "Person/company to enrich. Provide what you have.",
        properties: {
          firstName: { type: "string" },
          lastName: { type: "string" },
          fullName: { type: "string" },
          companyName: { type: "string" },
          domain: { type: "string" },
          linkedinUrl: { type: "string" },
        },
      },
    },
  },
  paths: {
    "/v1/signals/catalog": {
      get: {
        summary: "List every hiring signal RecruitersOS detects",
        parameters: [
          { name: "motion", in: "query", schema: { type: "string", enum: ["recruiting", "business_dev"] } },
        ],
        responses: {
          "200": { description: "The signal catalog" },
          "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/v1/signals/collect": {
      post: {
        summary: "Run one collection pass: pull → score → optionally trigger",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  icp: { $ref: "#/components/schemas/ICP" },
                  watchlist: { type: "object" },
                  limit: { type: "integer" },
                  triggerTopN: { type: "integer" },
                  enrich: { type: "boolean" },
                },
                required: ["icp"],
              },
            },
          },
        },
        responses: { "200": { description: "Scored work-list + triggers" } },
      },
    },
    "/v1/campaigns/build": {
      post: {
        summary: "Organize FREE signals into a reviewable campaign draft before launch",
        description:
          "Pulls from free/public sources, applies an industry/job-title filter, ranks " +
          "and segments targets, and returns a cost estimate — without spending on enrichment.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  icp: { $ref: "#/components/schemas/ICP" },
                  filter: {
                    type: "object",
                    properties: {
                      industries: { type: "array", items: { type: "string" } },
                      functions: { type: "array", items: { type: "string" } },
                      titleIncludes: { type: "array", items: { type: "string" } },
                      minSeniority: { type: "string" },
                      decisionMakersOnly: { type: "boolean" },
                      locations: { type: "array", items: { type: "string" } },
                    },
                  },
                  watchlist: { type: "object" },
                  maxTargets: { type: "integer" },
                  wantPhone: { type: "boolean" },
                },
                required: ["name", "icp", "filter"],
              },
            },
          },
        },
        responses: { "200": { description: "A reviewable CampaignDraft with targets, segments, and cost estimate" } },
      },
    },
    "/v1/signals/ingest": {
      post: {
        summary: "Push your own signal into RecruitersOS",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  title: { type: "string" },
                  detail: { type: "string" },
                  anchor: { type: "string" },
                  evidence: { type: "object" },
                },
                required: ["type", "title", "anchor"],
              },
            },
          },
        },
        responses: { "202": { description: "Accepted" } },
      },
    },
    "/v1/enrich": {
      post: {
        summary: "Run the cheap-first contact waterfall for one subject",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  subject: { $ref: "#/components/schemas/Subject" },
                  includePhone: { type: "boolean" },
                  budget: { type: "number" },
                },
                required: ["subject"],
              },
            },
          },
        },
        responses: { "200": { description: "Resolved values with provenance + cost trace" } },
      },
    },
    "/v1/config": {
      get: { summary: "Read workspace integration config (keys, providers, webhooks)", responses: { "200": { description: "Config" } } },
    },
    "/v1/config/providers": {
      post: { summary: "Upsert a provider credential and its waterfall order", responses: { "200": { description: "Saved" } } },
    },
    "/v1/config/webhooks": {
      post: { summary: "Register a webhook subscription", responses: { "201": { description: "Created; returns signingSecret once" } } },
    },
  },
} as const;

/** Serve helper: the spec as a JSON string. */
export function openApiJson(): string {
  return JSON.stringify(OPENAPI, null, 2);
}
