import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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

/**
 * Re-admit the process-active plugin generation for a detached review.
 *
 * The review is armed by the foreground turn but executes after the idle delay,
 * and the scheduler deliberately drops the predecessor's plugin generation and
 * prepared model runtime scopes before the timer fires. Without a generation in
 * scope, model resolution cannot see plugin-owned providers (for example
 * `opencode-go`), so the review fails with `Unknown model` and, because it runs
 * with fallbacks disabled, dies instead of degrading. A predecessor's scope is
 * never reused; only the currently active generation is re-entered.
 */
function resolveCurrentPluginGeneration(
  config: OpenClawConfig,
): { metadataSnapshot: PluginMetadataSnapshot; pluginRegistry?: PluginRegistry } | undefined {
  const metadataSnapshot = getCurrentPluginMetadataSnapshot({
    config,
    allowScopedSnapshot: true,
    allowWorkspaceScopedSnapshot: true,
  });
  if (!metadataSnapshot) {
    return undefined;
  }
  const pluginRegistry =
    getPluginRuntimeGenerationRegistry() ?? getPluginRegistryState()?.activeRegistry ?? undefined;
  return { metadataSnapshot, ...(pluginRegistry ? { pluginRegistry } : {}) };
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
    const generation = resolveCurrentPluginGeneration(params.config);
    return generation ? await withPluginRuntimeGenerationScope(generation, run) : await run();
  } finally {
    preparedRunAdmission.close();
  }
}
