import { env, RpcTarget, type RpcStub } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import type {
  ApprovalQueue, GitCache, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";

// The Workshop's queue, as far as a search uses it: it holds the provider an admin set, and it
// refuses every record, which must stop a search before anything is sent.
class RefusingQueue extends RpcTarget implements ApprovalQueue {
  readonly settingsRead: string[] = [];
  readonly refused: ObservationDescription[] = [];
  readonly #provider: string;

  constructor(provider: string) {
    super();
    this.#provider = provider;
  }

  async getAdminSetting(id: string): Promise<string | undefined> {
    this.settingsRead.push(id);
    return this.#provider;
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.refused.push(description);
    throw new Error("refused");
  }

  getGitCache(): Promise<GitCache> { return unexpected(); }
  requireLive(): Promise<void> { return unexpected(); }
  watchSession(): Promise<RpcStub<RpcTarget>> { return unexpected(); }
  getExecutionId(): Promise<string | undefined> { return unexpected(); }
  submitAction(): Promise<void> { return unexpected(); }
  bindHook(): Promise<void> { return unexpected(); }
}

function unexpected(): never {
  throw new Error("A search uses only the queue's setting and its record.");
}

it("searches with the provider an admin set, and records it before anything is sent", async () => {
  const queue = new RefusingQueue("linkup");
  using session = await env.WEB_SEARCH_GATEKEEPER.getByName("admin-setting").startSession(queue);
  const search = async () => { await session.search("durable objects alarms"); };

  // The test Worker has no AI binding, so a search that went on past the refused record would
  // fail for want of one instead.
  await expect(search()).rejects.toThrow("refused");
  expect(queue.settingsRead).toEqual(["provider"]);
  expect(queue.refused).toHaveLength(1);
  expect(queue.refused[0].description).toContain('"linkup"');
});

it("tells an admin which providers there are, when the one they set is not among them", async () => {
  const vendor = createExecutionContext().exports.GatekeeperVendor({});
  const set = async (value: string) => { await vendor.validateAdminSetting("provider", value); };

  await expect(set("bing")).rejects.toThrow("The search provider must be one of");
  await expect(set("openai/gpt-6-luna")).resolves.toBeUndefined();
});
