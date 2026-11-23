// Web Search request handling, separate from the Worker's RPC entrypoints.

import { z } from "zod";
import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import CERAMIC_QUERY_GUIDANCE from "./ceramic-query-guidance.txt";
import { modelSearchRequest, readModelResults, type ModelProvider } from "./model-search.js";
import type { WebSearchResult } from "./types.js";

// The providers of Cloudflare's Web Search API, and the model providers whose own search a model
// of theirs can run. The operator names one in WEB_SEARCH_PROVIDER, the second kind as
// `<provider>/<model>`. A query goes to that one alone: there is no fallback, which would be one
// more way out of the platform.
const API_PROVIDER = z.enum(["ceramic", "linkup", "exa"]);
const MODEL_PROVIDER = z.enum(["anthropic", "openai"]) satisfies z.ZodType<ModelProvider>;
type Provider =
  | { api: z.infer<typeof API_PROVIDER> }
  | { vendor: ModelProvider; model: string };

// Named rather than left to the API's default, which Cloudflare could change. Credit-billed
// Ceramic searches have zero data retention; with an operator's own key stored on the gateway, or
// any other provider, that provider's terms apply.
const DEFAULT_PROVIDER = "ceramic";

// Every account has an AI Gateway named "default", so a deploy that sets no CF_AI_GATEWAY works.
const DEFAULT_GATEWAY = "default";

// The API's limit on a query's length.
const MAX_QUERY_CHARS = 1024;

const MAX_RESULTS = 10;

// What the caller sees of each result; zod drops the rest (image and favicon URLs).
const RESULT_SCHEMA = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string().optional(),
  lastModifiedDate: z.string().optional(),
}) satisfies z.ZodType<WebSearchResult>;
const RESPONSE_SCHEMA = z.object({ items: z.array(RESULT_SCHEMA) });

function parseProvider(setting: string): Provider {
  const api = API_PROVIDER.safeParse(setting);
  if (api.success) return { api: api.data };
  const [, vendorName, model] = /^([^/]+)\/(.+)$/.exec(setting) ?? [];
  const vendor = MODEL_PROVIDER.safeParse(vendorName);
  if (vendor.success && model !== undefined) return { vendor: vendor.data, model };
  throw new Error("WEB_SEARCH_PROVIDER must be one of: " + [
    ...API_PROVIDER.options, ...MODEL_PROVIDER.options.map(name => `${name}/<model>`),
  ].join(", ") + ".");
}

/**
 * The declarations that tell an agent how to write queries for the provider `env` names, to
 * follow `types.d.ts`. Only Ceramic has any: it matches keywords, not meaning, and the guidance
 * was measured for it alone (see the README).
 */
export function queryGuidance(env: { WEB_SEARCH_PROVIDER?: string }): string {
  return (env.WEB_SEARCH_PROVIDER ?? DEFAULT_PROVIDER) === "ceramic" ? CERAMIC_QUERY_GUIDANCE : "";
}

/**
 * Searches the web for `query` with the provider `WEB_SEARCH_PROVIDER` names, or Ceramic when that
 * is unset, through the Workers AI binding and the `CF_AI_GATEWAY` gateway, or `default` when that
 * is unset. Calls `audit` once, before the query is sent, and throws without sending anything if
 * the provider setting is not one it knows, the query is empty or too long, or `audit` throws.
 */
export async function search(
  env: {
    AI: Pick<Ai, "websearch"> & { gateway(gatewayId: string): Pick<AiGateway, "run"> };
    CF_AI_GATEWAY?: string;
    WEB_SEARCH_PROVIDER?: string;
  },
  query: string,
  audit: (description: ObservationDescription) => Promise<void>,
): Promise<WebSearchResult[]> {
  const provider = parseProvider(env.WEB_SEARCH_PROVIDER ?? DEFAULT_PROVIDER);
  if (query.length === 0 || query.length > MAX_QUERY_CHARS) {
    throw new Error(`A search query must be 1 to ${MAX_QUERY_CHARS} characters.`);
  }

  // Recorded first: the query is what leaves, and a refused or failed record must stop it.
  await audit(describeSearch(query, provider));
  const gatewayId = env.CF_AI_GATEWAY ?? DEFAULT_GATEWAY;
  const response = "vendor" in provider
      ? await env.AI.gateway(gatewayId).run(
          modelSearchRequest(provider.vendor, provider.model, query, MAX_RESULTS))
      : await env.AI.websearch({ gatewayId, query, provider: provider.api, limit: MAX_RESULTS });
  if (!response.ok) {
    // Not the body, which may quote the query back.
    throw new Error(`Web search failed with HTTP ${response.status}.`);
  }
  const body: unknown = await response.json();
  return "vendor" in provider
      ? readModelResults(provider.vendor, body, MAX_RESULTS)
      : RESPONSE_SCHEMA.parse(body).items;
}

// Built with the kit's builder, so the query is shown exactly: as a literal field, escaped as JSON
// if it contains invisible characters.
function describeSearch(query: string, provider: Provider): ObservationDescription {
  const { description, fields } = buildDescription("vendor" in provider
        ? `Sends the query through AI Gateway to the "${provider.vendor}" model ` +
          `"${provider.model}", which searches the public web with queries it writes from it.`
        : `Searches the public web through AI Gateway, with the "${provider.api}" provider.`)
    .inline("Query", query)
    .finish();
  return { title: "Search the web", description, fields, subresources: [] };
}
