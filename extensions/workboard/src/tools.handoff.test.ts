// Workboard handoff tool boundary: the claimed card closes and the receiving agent can claim the copy.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { toolsByName } from "./test/interaction-fixtures.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

function toolSet(store: ReturnType<typeof createWorkboardSqliteTestStore>, agentId = "main") {
  return toolsByName(createWorkboardTools({ store, context: { agentId } }));
}

function toolSetWithAgents(
  store: ReturnType<typeof createWorkboardSqliteTestStore>,
  agentId: string,
  agentIds: string[],
) {
  const entries = Object.fromEntries(agentIds.map((known) => [known, {}]));
  const context = { agentId, config: { agents: { entries } } } as never;
  return toolsByName(createWorkboardTools({ store, context }));
}

function runTool(tools: ReturnType<typeof toolSet>, name: string, params: Record<string, unknown>) {
  return expectDefined(tools.get(`workboard_${name}`), name).execute(name, params);
}

async function payload(
  tools: ReturnType<typeof toolSet>,
  name: string,
  params: Record<string, unknown>,
) {
  const result = (await runTool(tools, name, params)) as { details?: Record<string, unknown> };
  return result.details ?? {};
}

describe("workboard_handoff tool", () => {
  it("hands a claimed card to another agent and lets that agent claim the copy", async () => {
    const store = createWorkboardSqliteTestStore();
    const workerTools = toolSet(store, "worker");
    const card = await store.create({ title: "Handoff through the tool", status: "running" });
    const token = (await payload(workerTools, "claim", { id: card.id })).token as string;

    const handed = await payload(workerTools, "handoff", {
      id: card.id,
      token,
      toAgent: "reviewer",
      note: "your call",
    });
    expect(handed.card).toMatchObject({
      status: "done",
      metadata: {
        closureReason: "handed_off_to",
        review: { required: true, status: "skipped", actor: "worker" },
      },
    });
    const destination = handed.destination as { id: string; status: string; agentId?: string };
    expect(destination).toMatchObject({ agentId: "reviewer", status: "ready" });

    const claimed = await payload(toolSet(store, "reviewer"), "claim", { id: destination.id });
    expect(claimed.card).toMatchObject({ agentId: "reviewer", status: "running" });
  });

  it("refuses a handoff from a caller that does not own the claim", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Owned elsewhere", status: "running" });
    await store.claim(card.id, { ownerId: "worker", token: "token-worker" });

    await expect(
      runTool(toolSet(store, "stranger"), "handoff", {
        id: card.id,
        token: "not-the-token",
        toAgent: "reviewer",
      }),
    ).rejects.toThrow(/card is claimed by worker/);
    expect((await store.get(card.id))?.status).toBe("running");
    expect(await store.list()).toHaveLength(1);
  });

  it("refuses an unknown receiving agent without creating a card", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = toolSetWithAgents(store, "worker", ["worker", "reviewer"]);
    const card = await store.create({ title: "Typo target", status: "running" });
    const token = (await payload(tools, "claim", { id: card.id })).token as string;

    await expect(
      runTool(tools, "handoff", { id: card.id, token, toAgent: "reviwer" }),
    ).rejects.toThrow(/Unknown agent "reviwer".*Configured agents: reviewer, worker/);

    expect(await store.list()).toHaveLength(1);
    expect((await store.get(card.id))?.status).toBe("running");
  });

  it("does not refuse a valid agent when the roster lists no other entries", async () => {
    const store = createWorkboardSqliteTestStore();
    // Empty entries: the roster property exists but is empty, so listAgentIds returns [].
    // This proves the empty-list guard (skip validation), not the legacy fallback below.
    const tools = toolSetWithAgents(store, "worker", []);
    const card = await store.create({ title: "Empty roster", status: "running" });
    const token = (await payload(tools, "claim", { id: card.id })).token as string;

    const handed = await payload(tools, "handoff", {
      id: card.id,
      token,
      toAgent: "reviewer",
    });
    expect(handed.destination).toMatchObject({ agentId: "reviewer" });
    expect((await store.get(card.id))?.status).toBe("done");
  });

  it("falls back to the implicit main agent when no roster property is configured", async () => {
    const store = createWorkboardSqliteTestStore();
    // No agents property at all: the roster helper's legacy fallback is ["main"], which is the
    // path a pre-roster config takes in production.
    const tools = toolsByName(
      createWorkboardTools({ store, context: { agentId: "worker", config: {} } as never }),
    );
    const card = await store.create({ title: "Legacy config", status: "running" });
    const token = (await payload(tools, "claim", { id: card.id })).token as string;

    await expect(
      runTool(tools, "handoff", { id: card.id, token, toAgent: "reviewer" }),
    ).rejects.toThrow(/Unknown agent "reviewer".*Configured agents: main/);
    expect(await store.list()).toHaveLength(1);
  });
});
