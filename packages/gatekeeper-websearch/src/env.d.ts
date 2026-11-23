// Project-specific Env augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    // The AI Gateway searches go through. The deploy service sets the instance's; it is not in the
    // config, because previews upload a backend secret under this name.
    CF_AI_GATEWAY?: string;
    // Where searches go: a Web Search API provider, or `<provider>/<model>` for a model provider's
    // own search (see search.ts). Unset, Ceramic. Set by whoever deploys the instance, never in
    // the committed config, where it would become every deployment's choice.
    WEB_SEARCH_PROVIDER?: string;
  }
}
