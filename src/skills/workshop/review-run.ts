import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../../plugins/runtime/generation-scope.js";
import { createBackgroundWorkOwner } from "../../process/background-work.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";

const reviews = createBackgroundWorkOwner({ owner: "core:skill-workshop", maxConcurrent: 1 });
const log = createSubsystemLogger("skills/workshop");

type CurrentPluginGenerationProbe = {
  generation:
    | { metadataSnapshot: PluginMetadataSnapshot; pluginRegistry?: PluginRegistry }
    | undefined;
  metadata: "present" | "missing";
  registry: "frame" | "state" | "missing";
};

function resolveCurrentPluginGeneration(config: OpenClawConfig): CurrentPluginGenerationProbe {
  const metadataSnapshot = getCurrentPluginMetadataSnapshot({
    config,
    allowScopedSnapshot: true,
    allowWorkspaceScopedSnapshot: true,
  });
  const frameRegistry = getPluginRuntimeGenerationRegistry();
  const stateRegistry = frameRegistry ?? getPluginRegistryState()?.activeRegistry ?? undefined;
  const registry: CurrentPluginGenerationProbe["registry"] = frameRegistry
    ? "frame"
    : stateRegistry
      ? "state"
      : "missing";
  return {
    generation: metadataSnapshot
      ? { metadataSnapshot, ...(stateRegistry ? { pluginRegistry: stateRegistry } : {}) }
      : undefined,
    metadata: metadataSnapshot ? "present" : "missing",
    registry,
  };
}

/** Temporary diagnostics for the detached-review model-resolution failure. */
function describeReviewFailure(error: unknown): string {
  const parts = [`error=${formatErrorMessage(error)}`];
  if (error instanceof Error && error.stack) {
    const frames = error.stack
      .split("\n")
      .slice(1, 6)
      .map((line) => line.trim())
      .filter(Boolean);
    if (frames.length > 0) {
      parts.push(`stack=${frames.join(" | ")}`);
    }
  }
  return parts.join(" ");
}

/** Experience reviews retain admission, model locking, and background capacity. */
export async function runSkillWorkshopReview(
  params: RunEmbeddedAgentParams & {
    agentId: string;
    config: OpenClawConfig;
  },
) {
  const restartSignal = getGatewayRestartDrainSignal();
  const abortSignal = params.abortSignal
    ? AbortSignal.any([restartSignal, params.abortSignal])
    : restartSignal;
  abortSignal.throwIfAborted();
  const preparedRunAdmission =
    params.preparedRunAdmission ??
    prepareSystemAgentRunAdmission(
      params.config,
      params.runId,
      params.agentId,
      "skill-workshop.experience",
    );
  try {
    const { runEmbeddedAgent } = await import("../../agents/embedded-agent.js");
    const run = () =>
      runEmbeddedAgent({
        ...params,
        preparedRunAdmission,
        abortSignal,
        lane: reviews.lane,
        agentHarnessId: "openclaw",
        agentHarnessRuntimeOverride: "openclaw",
        // Review prompts and cloned prefixes are sized for this exact model.
        modelSelectionLocked: true,
        modelFallbacksOverride: [],
        requestedRouteResolution: "resolved",
        disableTrajectory: true,
        skillWorkshopProposalOnly: params.skillWorkshopProposalOnly ?? true,
        cleanupBundleMcpOnRunEnd: true,
        verboseLevel: "off",
      });
    const probe = resolveCurrentPluginGeneration(params.config);
    const scoped = probe.generation ? "yes" : "no";
    log.info(
      `review model runtime: model=${params.provider}/${params.model} scoped=${scoped} snapshot=${probe.metadata} registry=${probe.registry}`,
    );
    try {
      return probe.generation
        ? await withPluginRuntimeGenerationScope(probe.generation, run)
        : await run();
    } catch (error) {
      log.warn(
        `review run failed: scoped=${scoped} snapshot=${probe.metadata} registry=${probe.registry} model=${params.provider}/${params.model} ${describeReviewFailure(error)}`,
      );
      throw error;
    }
  } finally {
    preparedRunAdmission.close();
  }
}
