import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import type { RunEmbeddedAgentInternalParams as AgentRequest } from "../agents/embedded-agent-runner/run/internal-params.js";
import { PluginDeliveryCapabilityError } from "../agents/plugin-delivery-capability-error.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";
import * as h from "./isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await h.loadRunCronIsolatedAgentTurn();
const { resolveAgentDir } = await import("./isolated-agent/run.runtime.js");
// Install the harness before capture loads the shared scheduled-model selector.
const { captureCronInferenceBinding } = await import("./inference-binding.runtime.js");

const PROFILE_ID = "openai:platform";
const INCOMPATIBLE = "incompatible with its recorded inference account";
const INACTIVE = "plugin delivery capability is no longer active";

describe("bound job fallback through the real runner", () => {
  setupRunCronIsolatedAgentTurnSuite();
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "cron-bound-fallback",
      env: { OPENAI_API_KEY: undefined, OPENAI_OAUTH_TOKEN: undefined },
    });
    // The real credential owner resolves the canonical main directory, not a custom test root.
    vi.mocked(resolveAgentDir).mockReturnValue(state.agentDir());
    h.loadModelCatalogOwnerMock.mockImplementation(async ({ config: cfg, agentId = "main" }) => ({
      agentId,
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config: cfg,
      modelCatalog: { entries: [], routeVariants: [] },
    }));
    h.resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-4.1" });
    h.resolveAllowedModelRefMock.mockReturnValue({ ref: { provider: "openai", model: "gpt-4.1" } });
    const actual = await vi.importActual<typeof import("../agents/model-fallback-runner.js")>(
      "../agents/model-fallback-runner.js",
    );
    h.runWithModelFallbackMock.mockImplementation(actual.runWithModelFallback);
  });

  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    await state.cleanup();
  });

  async function runBoundJob(fallbacks: string[], primaryFailure: Error) {
    await persistAuthProfileBatch({
      profiles: [
        {
          profileId: PROFILE_ID,
          credential: { type: "api_key", provider: "openai", key: "synthetic-platform-key" },
        },
      ],
    });
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
        defaults: { model: "openai/gpt-4.1" },
      },
      auth: {
        profiles: { [PROFILE_ID]: { provider: "openai", mode: "api_key" } },
        order: { openai: [PROFILE_ID] },
      },
    };
    const binding = await captureCronInferenceBinding({
      cfg,
      agentId: "main",
      model: `openai/gpt-4.1@${PROFILE_ID}`,
    });
    cfg.agents!.defaults!.model = { primary: "openai/gpt-4.1", fallbacks };
    const attempted: string[] = [];
    h.runEmbeddedAgentMock.mockImplementation(async (request: AgentRequest) => {
      attempted.push(`${request.provider}/${request.model}`);
      if (attempted.length === 1) {
        throw primaryFailure;
      }
      request.userTurnTranscriptRecorder?.markBlocked();
      return { payloads: [{ text: "fallback reply" }], meta: { agentMeta: {} } };
    });
    const job = makeIsolatedAgentJobFixture({
      agentId: "main",
      delivery: { mode: "none" },
      payload: { kind: "agentTurn", message: "check status" },
      inferenceBinding: binding ?? undefined,
    });
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg,
        job,
        message: "check status",
        sessionKey: "cron:job-1",
        lane: "cron",
      }),
    );
    return { result, attempted };
  }

  it.each([
    ["direct", () => new PluginDeliveryCapabilityError()],
    [
      "lane-wrapped",
      () => new Error("lane task error", { cause: new PluginDeliveryCapabilityError() }),
    ],
  ])("reports a %s delivery failure without attempting any fallback", async (_label, failure) => {
    const { result, attempted } = await runBoundJob(
      ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
      failure(),
    );
    expect(attempted).toEqual(["openai/gpt-4.1"]);
    expect(result.status).toBe("error");
    expect(result.error).toContain(INACTIVE);
    expect(result.error).not.toContain(INCOMPATIBLE);
  });

  it("reports the primary failure when every fallback is incompatible", async () => {
    const { result, attempted } = await runBoundJob(
      ["anthropic/claude-sonnet-4-5"],
      new Error("synthetic primary failure"),
    );
    expect(attempted).toEqual(["openai/gpt-4.1"]);
    expect(result.status).toBe("error");
    expect(result.error).toContain("synthetic primary failure");
    expect(result.error).not.toContain(INCOMPATIBLE);
  });

  it("skips an incompatible fallback and runs a compatible one", async () => {
    const { result, attempted } = await runBoundJob(
      ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
      new Error("synthetic primary failure"),
    );
    expect(attempted).toEqual(["openai/gpt-4.1", "openai/gpt-4o"]);
    expect(result.status, result.error).toBe("ok");
  });
});
