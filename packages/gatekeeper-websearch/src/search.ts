// Web Search request handling, separate from the Worker's RPC entrypoints.

import { z } from "zod";
import { buildDescription, codeSpan } from "@gadgets/gatekeeper-kit/action-description";
import type {
  GatekeeperAdminSetting, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  modelSearchRequest, parseProviderJson, readModelResults, type ModelProvider,
} from "./model-search.js";
import type { WebSearchResult } from "./types.js";

// The providers of Cloudflare's Web Search API, and the model providers whose own search a model
// of theirs can run. A deployment admin names one (PROVIDER_SETTING), the second kind as
// `<provider>/<model>`. A query goes to that one alone: there is no fallback, which would be one
// more way out of the platform.
const API_PROVIDER = z.enum(["ceramic", "linkup", "exa"]);
const MODEL_PROVIDER = z.enum(["anthropic", "openai"]) satisfies z.ZodType<ModelProvider>;
type Provider =
  | { api: z.infer<typeof API_PROVIDER> }
  | { vendor: ModelProvider; model: string };

/**
 * The admin setting that names where searches go. The default is named rather than left to the
 * API's default, which Cloudflare could change. Credit-billed Ceramic searches have zero data
 * retention; with an operator's own key stored on the gateway, or any other provider, that
 * provider's terms apply.
 */
export const PROVIDER_SETTING: GatekeeperAdminSetting = {
  id: "provider",
  label: "Search provider",
  help: "Where searches go: ceramic, linkup or exa on Cloudflare's Web Search API, or " +
      "anthropic/<model> or openai/<model> for that provider's own web search, such as " +
      "openai/gpt-6-luna. A query can hold workspace text, and the provider's data terms apply " +
      "to it.",
  defaultValue: "ceramic",
};

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

/** The provider `setting` names. Throws, listing the values the setting takes, if it names none. */
export function parseProvider(setting: string): Provider {
  const api = API_PROVIDER.safeParse(setting);
  if (api.success) return { api: api.data };
  // An admin types the model ID, and each search's record shows it. So it is held to the
  // characters model IDs use and to 100 of them: a mistyped setting is refused here, not sent,
  // and no ID can write markup into a record or crowd the query out of it.
  const [, vendorName, model] =
      /^([^/]+)\/([A-Za-z0-9][A-Za-z0-9._:-]{0,99})$/.exec(setting) ?? [];
  const vendor = MODEL_PROVIDER.safeParse(vendorName);
  if (vendor.success && model !== undefined) return { vendor: vendor.data, model };
  throw new Error("The search provider must be one of: " + [
    ...API_PROVIDER.options, ...MODEL_PROVIDER.options.map(name => `${name}/<model>`),
  ].join(", ") + ".");
}

/**
 * Searches the web for `query` with the provider the admin set (`provider`, the value of
 * PROVIDER_SETTING, or undefined for its default), through the Workers AI binding and the
 * `CF_AI_GATEWAY` gateway, or `default` when that is unset. Calls `audit` once, before the query
 * is sent, and throws without sending anything if `provider` is not one it knows, the query is
 * empty or too long, or `audit` throws.
 */
export async function search(
  config: {
    AI: Pick<Ai, "websearch"> & { gateway(gatewayId: string): Pick<AiGateway, "run"> };
    CF_AI_GATEWAY?: string;
    provider: string | undefined;
  },
  query: string,
  audit: (description: ObservationDescription) => Promise<void>,
): Promise<WebSearchResult[]> {
  const provider = parseProvider(config.provider ?? PROVIDER_SETTING.defaultValue);
  if (query.length === 0 || query.length > MAX_QUERY_CHARS) {
    throw new Error(`A search query must be 1 to ${MAX_QUERY_CHARS} characters.`);
  }

  // Recorded first: the query is what leaves, and a refused or failed record must stop it.
  await audit(describeSearch(query, provider));
  const gatewayId = config.CF_AI_GATEWAY ?? DEFAULT_GATEWAY;
  const response = "vendor" in provider
      ? await config.AI.gateway(gatewayId).run(
          modelSearchRequest(provider.vendor, provider.model, query, MAX_RESULTS))
      : await config.AI.websearch({ gatewayId, query, provider: provider.api, limit: MAX_RESULTS });
  if (!response.ok) {
    // Not the body, which may quote the query back.
    throw new Error(`Web search failed with HTTP ${response.status}.`);
  }
  const body = parseProviderJson(await response.text());
  return "vendor" in provider
      ? readModelResults(provider.vendor, body, MAX_RESULTS)
      : RESPONSE_SCHEMA.parse(body).items;
}

// Built with the kit's builder, so the query is shown exactly: as a literal field, escaped as JSON
// if it contains invisible characters.
function describeSearch(query: string, provider: Provider): ObservationDescription {
  const { description, fields } = buildDescription("vendor" in provider
        ? `Sends the query through AI Gateway to the "${provider.vendor}" model ` +
          `${codeSpan(provider.model)}, which searches the public web with queries it writes ` +
          `from it.`
        : `Searches the public web through AI Gateway, with the "${provider.api}" provider.`)
    .inline("Query", query)
    .finish();
  return { title: "Search the web", description, fields, subresources: [] };
}
