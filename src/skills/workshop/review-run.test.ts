import { beforeEach, describe, expect, it, vi } from "vitest";

const metadataSnapshot = { snapshotId: "snap" } as never;
const activeRegistry = { registryId: "registry" } as never;

const runEmbeddedAgent = vi.fn(async () => ({ ok: true }) as never);
const withPluginRuntimeGenerationScope = vi.fn((_generation: unknown, run: () => unknown) => run());
const getPluginRuntimeGenerationRegistry = vi.fn(() => undefined as never);
const getPluginRegistryState = vi.fn(() => ({ activeRegistry }) as never);
const getCurrentPluginMetadataSnapshot = vi.fn(() => metadataSnapshot as never);

vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));
vi.mock("../../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot,
}));
vi.mock("../../plugins/runtime-state.js", () => ({ getPluginRegistryState }));
vi.mock("../../plugins/runtime/generation-scope.js", () => ({
  withPluginRuntimeGenerationScope,
  getPluginRuntimeGenerationRegistry,
}));

const { runSkillWorkshopReview } = await import("./review-run.js");

function baseParams() {
  return {
    agentId: "main",
    config: {} as never,
    preparedRunAdmission: { close() {} } as never,
    runId: "run-1",
  } as never;
}

describe("runSkillWorkshopReview plugin generation re-admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentPluginMetadataSnapshot.mockReturnValue(metadataSnapshot as never);
    getPluginRegistryState.mockReturnValue({ activeRegistry } as never);
    getPluginRuntimeGenerationRegistry.mockReturnValue(undefined as never);
  });

  it("re-enters the process-active plugin generation around the embedded run", async () => {
    await runSkillWorkshopReview(baseParams());

    expect(withPluginRuntimeGenerationScope).toHaveBeenCalledTimes(1);
    expect(withPluginRuntimeGenerationScope.mock.calls[0]?.[0]).toEqual({
      metadataSnapshot,
      pluginRegistry: activeRegistry,
    });
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
  });

  it("prefers an in-scope generation registry when one exists", async () => {
    const scopedRegistry = { registryId: "scoped" } as never;
    getPluginRuntimeGenerationRegistry.mockReturnValue(scopedRegistry as never);

    await runSkillWorkshopReview(baseParams());

    expect(withPluginRuntimeGenerationScope.mock.calls[0]?.[0]).toEqual({
      metadataSnapshot,
      pluginRegistry: scopedRegistry,
    });
  });

  it("runs unscoped when no metadata snapshot can be resolved", async () => {
    getCurrentPluginMetadataSnapshot.mockReturnValue(undefined as never);

    await runSkillWorkshopReview(baseParams());

    expect(withPluginRuntimeGenerationScope).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
  });
});
