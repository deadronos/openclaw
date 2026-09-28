import { beforeEach, describe, expect, it, vi } from "vitest";

const lease = {
  snapshot: { snapshotId: "snapshot" },
  pluginGeneration: { generationId: "generation" },
  [Symbol.asyncDispose]: async () => {},
};

const runEmbeddedAgent = vi.fn(async () => ({ ok: true }) as never);
const withPluginRuntimeGenerationScope = vi.fn((_generation: unknown, run: () => unknown) => run());
const withPreparedModelRuntimePluginGenerationScope = vi.fn(
  (_generation: unknown, run: () => unknown, _borrow?: () => unknown) => run(),
);
const acquireAgentRunPreparedModelRuntime = vi.fn(async () => lease as never);
const resolveAgentDir = vi.fn(() => "/tmp/agent-dir");

vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));
vi.mock("../../agents/agent-scope-config.js", () => ({ resolveAgentDir }));
vi.mock("../../agents/prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime,
}));
vi.mock("../../agents/prepared-model-runtime-generation-scope.js", () => ({
  withPreparedModelRuntimePluginGenerationScope,
}));
vi.mock("../../plugins/runtime/generation-scope.js", () => ({
  withPluginRuntimeGenerationScope,
}));

const { runSkillWorkshopReview } = await import("./review-run.js");

function baseParams() {
  return {
    agentId: "main",
    config: {} as never,
    preparedRunAdmission: { close() {} } as never,
    runId: "run-1",
    workspaceDir: "/tmp/ws",
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
  } as never;
}

describe("runSkillWorkshopReview prepared model runtime lease", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireAgentRunPreparedModelRuntime.mockResolvedValue(lease as never);
  });

  it("acquires a lease and enters both generation scopes around the embedded run", async () => {
    await runSkillWorkshopReview(baseParams());

    expect(acquireAgentRunPreparedModelRuntime).toHaveBeenCalledTimes(1);
    const input = acquireAgentRunPreparedModelRuntime.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.agentId).toBe("main");
    expect(input.agentDir).toBe("/tmp/agent-dir");
    expect(input.workspaceDir).toBe("/tmp/ws");
    expect(input.allowGatewaySubagentBinding).toBe(true);
    expect(withPreparedModelRuntimePluginGenerationScope).toHaveBeenCalledTimes(1);
    expect(withPreparedModelRuntimePluginGenerationScope.mock.calls[0]?.[0]).toBe(
      lease.pluginGeneration,
    );
    expect(withPluginRuntimeGenerationScope).toHaveBeenCalledTimes(1);
    expect(withPluginRuntimeGenerationScope.mock.calls[0]?.[0]).toBe(lease.snapshot);
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
  });

  it("falls back to an unscoped run when the lease cannot be acquired", async () => {
    acquireAgentRunPreparedModelRuntime.mockRejectedValueOnce(new Error("no lease"));

    await runSkillWorkshopReview(baseParams());

    expect(withPreparedModelRuntimePluginGenerationScope).not.toHaveBeenCalled();
    expect(withPluginRuntimeGenerationScope).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
  });
});
