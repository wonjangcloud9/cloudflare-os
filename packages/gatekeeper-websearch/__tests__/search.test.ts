import { describe, expect, it, vi } from "vitest";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { queryGuidance, search } from "../src/search.js";

type WebSearch = Ai["websearch"];

function respond(items: unknown[]): WebSearch {
  return async () => Response.json({ items, metadata: { query: "q", requestId: "r", latencyMs: 1 } });
}

const insufficientCredits: WebSearch = async () =>
  new Response("insufficient credits for q", { status: 402 });

const cutShort: WebSearch = async () => new Response('{"items": [{"title": "q is a secr');

function recorder() {
  const descriptions: ObservationDescription[] = [];
  return {
    descriptions,
    audit: async (description: ObservationDescription) => {
      descriptions.push(description);
    },
  };
}

const refuse = async () => { throw new Error("refused"); };

const noGateway = (): never => { throw new Error("no model request expected"); };
const noWebSearch: WebSearch = async () => { throw new Error("no Web Search API call expected"); };

// A gateway other than "default", so a test can tell the configured one was used.
function env(websearch: WebSearch, provider?: string) {
  return {
    AI: { websearch, gateway: noGateway },
    CF_AI_GATEWAY: "instance-ai",
    ...(provider !== undefined && { WEB_SEARCH_PROVIDER: provider }),
  };
}

// A deployment whose provider is a model provider. `answer` answers its one model request.
function modelProvider(provider: string, answer: () => Response) {
  const run = vi.fn(async (_request: AIGatewayUniversalRequest) => answer());
  const gateway = vi.fn((_gatewayId: string) => ({ run }));
  return {
    run, gateway,
    env: {
      AI: { websearch: noWebSearch, gateway },
      CF_AI_GATEWAY: "instance-ai",
      WEB_SEARCH_PROVIDER: provider,
    },
  };
}

const PAGE = { title: "Alarms", description: "Each Durable Object can hold one alarm." };
const FOUND = "https://developers.cloudflare.com/durable-objects/api/alarms/";
const INVENTED = "https://evil.example/alarms";

// The blocks of an Anthropic response for a search that returned `urls`.
function anthropicSearch(...urls: string[]) {
  return [
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: urls.map(url => ({
        type: "web_search_result", url, title: "Alarms", page_age: "3 days ago",
        encrypted_content: "EqgB",
      })),
    },
  ];
}

function anthropicReport(...urls: string[]) {
  return {
    type: "tool_use", id: "toolu_1", name: "report_results",
    input: { results: urls.map(url => ({ url, ...PAGE })) },
  };
}

// The item of an OpenAI response for a search that returned `urls`.
function openAiSearch(...urls: string[]) {
  return {
    type: "web_search_call", id: "ws_1", status: "completed",
    action: { type: "search", queries: ["q"], sources: urls.map(url => ({ type: "url", url })) },
  };
}

function openAiReport(...urls: string[]) {
  return {
    type: "function_call", id: "fc_1", call_id: "call_1", name: "report_results",
    status: "completed",
    arguments: JSON.stringify({ results: urls.map(url => ({ url, ...PAGE })) }),
  };
}

const anthropic = (...content: unknown[]) => () =>
  Response.json({ type: "message", role: "assistant", stop_reason: "tool_use", content });
const openAi = (...output: unknown[]) => () =>
  Response.json({ object: "response", status: "completed", output });

describe("search", () => {
  it("searches the configured gateway with Ceramic, or the provider that is set, and keeps " +
      "only the result fields", async () => {
    const websearch = vi.fn(respond([{
      url: "https://developers.cloudflare.com/workers/",
      title: "Cloudflare Workers",
      description: "Build serverless applications.",
      lastModifiedDate: "2026-09-30",
      faviconUrl: "https://developers.cloudflare.com/favicon.png",
    }]));

    const results = await search(env(websearch), "workers docs", recorder().audit);

    expect(websearch).toHaveBeenCalledWith(
        { gatewayId: "instance-ai", query: "workers docs", provider: "ceramic", limit: 10 });
    expect(results).toEqual([{
      url: "https://developers.cloudflare.com/workers/",
      title: "Cloudflare Workers",
      description: "Build serverless applications.",
      lastModifiedDate: "2026-09-30",
    }]);

    await search(env(websearch, "linkup"), "workers docs", recorder().audit);
    expect(websearch).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "linkup" }));
  });

  it("searches the default gateway when none is configured", async () => {
    const websearch = vi.fn(respond([]));

    await search({ AI: { websearch, gateway: noGateway } }, "q", recorder().audit);

    expect(websearch).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "default" }));
  });

  it("sends and records nothing for a query outside the API's 1 to 1,024 characters", async () => {
    const websearch = vi.fn(respond([]));
    const { audit, descriptions } = recorder();

    for (const query of ["", "q".repeat(1025)]) {
      await expect(search(env(websearch), query, audit)).rejects.toThrow("1 to 1024 characters");
    }
    await search(env(websearch), "q".repeat(1024), audit);
    expect(websearch).toHaveBeenCalledTimes(1);
    expect(descriptions).toHaveLength(1);
  });

  it("records the exact query, restricted by nothing", async () => {
    const { audit, descriptions } = recorder();

    await search(env(respond([])), "`code` and **markdown**", audit);

    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]).toMatchObject({
      fields: [{ label: "Query", kind: "inline", value: "`code` and **markdown**" }],
      subresources: [],
    });
  });

  it("sends nothing when the record is refused", async () => {
    const websearch = vi.fn(respond([]));

    await expect(search(env(websearch), "q", refuse)).rejects.toThrow("refused");
    expect(websearch).not.toHaveBeenCalled();
  });

  it("keeps the record of a search that fails after it was sent", async () => {
    const failures: WebSearch[] = [
      insufficientCredits,
      async () => { throw new Error("binding unavailable"); },
      async () => Response.json({ unexpected: true }),
    ];
    for (const websearch of failures) {
      const { audit, descriptions } = recorder();
      await expect(search(env(websearch), "q", audit)).rejects.toThrow();
      expect(descriptions).toHaveLength(1);
    }
  });

  it("reports a failed search's status without the provider's body", async () => {
    await expect(search(env(insufficientCredits), "q", recorder().audit))
      .rejects.toThrow(/^Web search failed with HTTP 402\.$/);
  });

  it("fails on a response that is not JSON, without quoting it in the error or its cause",
      async () => {
    const error = await search(env(cutShort), "q", recorder().audit)
      .catch((caught: unknown) => caught);

    expect(error).toEqual(new Error(
        "Web search failed: the provider's response was not valid JSON."));
    expect(error).not.toHaveProperty("cause");
  });

  it("refuses a provider setting it does not know, before anything is recorded or sent",
      async () => {
    const websearch = vi.fn(respond([]));
    const { audit, descriptions } = recorder();

    for (const provider of ["bing", "Ceramic", "anthropic", "openai/", "/gpt-6-luna"]) {
      await expect(search(env(websearch, provider), "q", audit), provider)
        .rejects.toThrow("WEB_SEARCH_PROVIDER must be");
    }
    expect(websearch).not.toHaveBeenCalled();
    expect(descriptions).toEqual([]);
  });
});

describe("search with a model provider", () => {
  it("asks the Anthropic model to search once, with the tool that only searches", async () => {
    const model = modelProvider("anthropic/claude-haiku-5-5",
        anthropic(...anthropicSearch(FOUND), anthropicReport(FOUND)));
    const { run } = model;
    const { audit, descriptions } = recorder();

    const results = await search(model.env, "durable objects alarms", audit);

    expect(model.gateway).toHaveBeenCalledWith("instance-ai");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      provider: "anthropic",
      endpoint: "v1/messages",
      query: expect.objectContaining({
        model: "claude-haiku-5-5",
        messages: [{ role: "user", content: "durable objects alarms" }],
        tools: expect.arrayContaining([
          { type: "web_search_20250305", name: "web_search", max_uses: 1 },
        ]),
      }),
    }));
    expect(results).toEqual([{ url: FOUND, ...PAGE }]);
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0].description).toContain("anthropic");
    expect(descriptions[0].description).toContain("claude-haiku-5-5");
  });

  it("asks the OpenAI model to search once, from OpenAI's cache only", async () => {
    const model = modelProvider("openai/gpt-6-luna",
        openAi(openAiSearch(FOUND), openAiReport(FOUND)));
    const { run } = model;

    const results = await search(model.env, "durable objects alarms", recorder().audit);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai",
      endpoint: "responses",
      query: expect.objectContaining({
        model: "gpt-6-luna",
        input: "durable objects alarms",
        max_tool_calls: 1,
        tools: expect.arrayContaining([{ type: "web_search", external_web_access: false }]),
      }),
    }));
    expect(results).toEqual([{ url: FOUND, ...PAGE }]);
  });

  it("keeps only results whose URL a search returned", async () => {
    const responses = {
      "anthropic/claude-haiku-5-5":
        anthropic(...anthropicSearch(FOUND), anthropicReport(INVENTED, FOUND)),
      "openai/gpt-6-luna": openAi(
        // A page the model opened is one it picked, not one a search returned.
        { type: "web_search_call", status: "completed", action: { type: "open_page", url: INVENTED } },
        openAiSearch(FOUND),
        openAiReport(INVENTED, FOUND)),
    };
    for (const [provider, answer] of Object.entries(responses)) {
      await expect(search(modelProvider(provider, answer).env, "q", recorder().audit), provider)
        .resolves.toEqual([{ url: FOUND, ...PAGE }]);
    }
  });

  it("returns no more than 10 results", async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://example.com/${i}`);
    const model = modelProvider("anthropic/claude-haiku-5-5",
        anthropic(...anthropicSearch(...urls), anthropicReport(...urls)));

    const results = await search(model.env, "q", recorder().audit);

    expect(results.map(result => result.url)).toEqual(urls.slice(0, 10));
  });

  it("returns nothing when a search ran and found nothing", async () => {
    const responses = {
      "anthropic/claude-haiku-5-5": anthropic(...anthropicSearch(), anthropicReport()),
      "openai/gpt-6-luna": openAi(openAiSearch(), openAiReport()),
    };
    for (const [provider, answer] of Object.entries(responses)) {
      await expect(search(modelProvider(provider, answer).env, "q", recorder().audit), provider)
        .resolves.toEqual([]);
    }
  });

  it("fails when no search succeeded, whatever the model reports", async () => {
    const [searchCall] = anthropicSearch();
    const responses: [string, () => Response][] = [
      // The model called the search beside the report, so Anthropic did not run it.
      ["anthropic/claude-haiku-5-5", anthropic(searchCall, anthropicReport(FOUND))],
      ["anthropic/claude-haiku-5-5", anthropic(
        searchCall,
        {
          type: "web_search_tool_result", tool_use_id: "srvtoolu_1",
          content: { type: "web_search_tool_result_error", error_code: "unavailable" },
        },
        anthropicReport())],
      // The cap on tool calls cut the search off after the model opened a page instead.
      ["openai/gpt-6-luna", openAi(
        { type: "web_search_call", status: "completed", action: { type: "open_page", url: FOUND } },
        { ...openAiSearch(FOUND), status: "searching" },
        openAiReport(FOUND))],
    ];
    for (const [provider, answer] of responses) {
      await expect(search(modelProvider(provider, answer).env, "q", recorder().audit), provider)
        .rejects.toThrow(/^Web search failed: the provider ran no search\.$/);
    }
  });

  it("fails when the model reports no result list", async () => {
    const model = modelProvider("anthropic/claude-haiku-5-5",
        anthropic(...anthropicSearch(FOUND), { type: "text", text: "Alarms wake an object." }));

    await expect(search(model.env, "q", recorder().audit))
      .rejects.toThrow(/^Web search failed: the provider reported no results\.$/);
  });

  it("fails on a result list cut short, without quoting it", async () => {
    const report = openAiReport(FOUND);
    const model = modelProvider("openai/gpt-6-luna",
        openAi(openAiSearch(FOUND), { ...report, arguments: report.arguments.slice(0, 40) }));

    await expect(search(model.env, "q", recorder().audit))
      .rejects.toThrow(/^Web search failed: the provider's response was not valid JSON\.$/);
  });
});

describe("queryGuidance", () => {
  // Under vitest a text module imports as its path, not its text, so only its presence shows.
  it("gives Ceramic's query rules to a Ceramic deployment alone", () => {
    expect(queryGuidance({})).not.toBe("");
    expect(queryGuidance({ WEB_SEARCH_PROVIDER: "ceramic" })).toBe(queryGuidance({}));
    for (const provider of ["linkup", "anthropic/claude-haiku-5-5", "openai/gpt-6-luna"]) {
      expect(queryGuidance({ WEB_SEARCH_PROVIDER: provider }), provider).toBe("");
    }
  });
});
