import { beforeEach, describe, expect, it, vi } from "vitest";

const lease = {
  snapshot: { snapshotId: "snapshot" },
  pluginGeneration: { generationId: "generation" },
  [Symbol.asyncDispose]: async () => {},
};

const run = vi.fn(async () => "ok");
const withPluginRuntimeGenerationScope = vi.fn((_generation: unknown, inner: () => unknown) =>
  inner(),
);
const withPreparedModelRuntimePluginGenerationScope = vi.fn(
  (_generation: unknown, inner: () => unknown, _borrow?: () => unknown) => inner(),
);
// Parameter types are declared so `mock.calls` is a typed tuple rather than
// an empty one, which keeps the call assertions below type-checked.
const acquireAgentRunPreparedModelRuntime = vi.fn(
  async (_input: Record<string, unknown>, _options?: Record<string, unknown>) => lease as never,
);
const publishedRuntime = { pluginGeneration: { generationId: "published-generation" } };
const loadPublishedGatewayReplyDispatchRuntime = vi.fn(async () => publishedRuntime as never);
const resolveAgentDir = vi.fn(() => "/tmp/agent-dir");

vi.mock("../../agents/agent-scope-config.js", () => ({ resolveAgentDir }));
vi.mock("../../agents/prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
}));
vi.mock("../../agents/prepared-model-runtime-generation-scope.js", () => ({
  withPreparedModelRuntimePluginGenerationScope,
}));
vi.mock("../../plugins/runtime/generation-scope.js", () => ({
  withPluginRuntimeGenerationScope,
}));

const { runWithExperienceReviewModelRuntime } =
  await import("./experience-review-model-runtime.js");

function request() {
  return {
    config: {} as never,
    agentId: "main",
    workspaceDir: "/tmp/ws",
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    abortSignal: new AbortController().signal,
  };
}

describe("runWithExperienceReviewModelRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireAgentRunPreparedModelRuntime.mockResolvedValue(lease as never);
    loadPublishedGatewayReplyDispatchRuntime.mockResolvedValue(publishedRuntime as never);
  });

  it("acquires a lease and enters both generation scopes around the review run", async () => {
    await expect(runWithExperienceReviewModelRuntime(request(), run)).resolves.toBe("ok");

    expect(acquireAgentRunPreparedModelRuntime).toHaveBeenCalledTimes(1);
    const input = acquireAgentRunPreparedModelRuntime.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.agentId).toBe("main");
    expect(input.agentDir).toBe("/tmp/agent-dir");
    expect(input.workspaceDir).toBe("/tmp/ws");
    expect(input.allowGatewaySubagentBinding).toBe(true);
    expect(input.runtimePluginSelections).toEqual([
      { provider: "opencode-go", modelId: "deepseek-v4.1-flash", agentId: "main" },
    ]);
    const options = acquireAgentRunPreparedModelRuntime.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(options.pluginGeneration).toBe(publishedRuntime.pluginGeneration);
    expect(loadPublishedGatewayReplyDispatchRuntime).toHaveBeenCalledTimes(1);
    expect(withPreparedModelRuntimePluginGenerationScope).toHaveBeenCalledTimes(1);
    expect(withPreparedModelRuntimePluginGenerationScope.mock.calls[0]?.[0]).toBe(
      lease.pluginGeneration,
    );
    expect(withPluginRuntimeGenerationScope).toHaveBeenCalledTimes(1);
    expect(withPluginRuntimeGenerationScope.mock.calls[0]?.[0]).toBe(lease.snapshot);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls back to an unscoped run when the lease cannot be acquired", async () => {
    acquireAgentRunPreparedModelRuntime.mockRejectedValueOnce(new Error("no lease"));

    await expect(runWithExperienceReviewModelRuntime(request(), run)).resolves.toBe("ok");

    expect(withPreparedModelRuntimePluginGenerationScope).not.toHaveBeenCalled();
    expect(withPluginRuntimeGenerationScope).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls back to an unbound acquisition when the published generation is unavailable", async () => {
    loadPublishedGatewayReplyDispatchRuntime.mockRejectedValueOnce(new Error("not published"));

    await expect(runWithExperienceReviewModelRuntime(request(), run)).resolves.toBe("ok");

    expect(acquireAgentRunPreparedModelRuntime).toHaveBeenCalledTimes(1);
    const options = acquireAgentRunPreparedModelRuntime.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(options.pluginGeneration).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("omits plugin selections when the review has no resolved model", async () => {
    const { provider: _provider, model: _model, ...rest } = request();

    await expect(runWithExperienceReviewModelRuntime(rest, run)).resolves.toBe("ok");

    const input = acquireAgentRunPreparedModelRuntime.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.runtimePluginSelections).toBeUndefined();
  });
});
