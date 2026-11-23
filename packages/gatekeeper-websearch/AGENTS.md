# Web Search

Web Search — an auto-provisioned gatekeeper whose account provides an ambient `WEB_SEARCH` singleton.
The README is the design record.

- It searches the public web through its own Workers AI binding and the AI Gateway its
  `CF_AI_GATEWAY` var names. The deploy service sets that var to the instance's gateway, the
  backend's; anywhere else it defaults to the account's `default` gateway.
- The operator names the provider in `WEB_SEARCH_PROVIDER`: a Web Search API provider
  (`websearch()`; Ceramic when unset), or `anthropic/<model>` or `openai/<model>` for that
  provider's own web search, run by one model request that holds only the query
  (`model-search.ts`). It is a Worker var, never an admin setting, and there is no fallback.
- Each query is recorded as an observation *before* it is sent. A workspace that has observed
  restricted data can still search: unlike a `webFetch` URL, the query can only go to the
  operator's provider. Keep that true: `model-search.ts` pins Anthropic's search-only tool
  version and OpenAI's cache-only mode, because with live access a query that names a URL makes
  OpenAI fetch it. Do not loosen either without rerunning the README's canary test.
- Preinstalled on every deploy like Scheduled Tasks; every search spends the account's AI Gateway
  credits or a provider key stored on the gateway, outside the model spend limits.
