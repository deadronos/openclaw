import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { withPreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import type { PreparedModelRuntimeLease } from "../../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { createBackgroundWorkOwner } from "../../process/background-work.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";

const reviews = createBackgroundWorkOwner({ owner: "core:skill-workshop", maxConcurrent: 1 });
const log = createSubsystemLogger("skills/workshop");

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
    // Mirror the admitted-run contract used by the reply and cron callers: acquire
    // this run's own prepared model runtime and re-enter both plugin generation
    // scopes, so the nested embedded run borrows a snapshot that includes
    // plugin-owned providers (for example `opencode-go`). Without the lease the
    // detached review resolves against a runtime prepared without the admitted
    // generation and fails with `Unknown model`.
    let lease: PreparedModelRuntimeLease | undefined;
    try {
      lease = await acquireAgentRunPreparedModelRuntime(
        {
          config: params.config,
          agentId: params.agentId,
          agentDir: resolveAgentDir(params.config, params.agentId),
          workspaceDir: params.workspaceDir,
          // Owner-key alignment: the gateway's configured generation is published with this
          // set (every admission/cron/reply caller passes it). Without it the lease cannot
          // reuse that generation and binds to a colder one whose catalog lacks live
          // plugin-provided models (for example `opencode-go`).
          allowGatewaySubagentBinding: true,
        },
        { catalogMode: "static", abortSignal },
      );
    } catch (error) {
      log.warn(`review model runtime lease failed: ${formatErrorMessage(error)}`);
    }
    const scoped = lease ? "lease" : "none";
    const catalogEntries = lease?.snapshot.modelCatalog?.entries;
    const catalogProbe = catalogEntries
      ? `catalogEntries=${catalogEntries.length} hasOpencodeGo=${catalogEntries.some((entry) => entry.provider === "opencode-go")}`
      : "catalog=n/a";
    log.info(
      `review model runtime: model=${params.provider}/${params.model} scoped=${scoped} ${catalogProbe}`,
    );
    try {
      if (!lease) {
        return await run();
      }
      await using leased = lease;
      let leaseActive = true;
      try {
        return await withPreparedModelRuntimePluginGenerationScope(
          leased.pluginGeneration,
          () => withPluginRuntimeGenerationScope(leased.snapshot, run),
          () => (leaseActive ? leased.snapshot : undefined),
        );
      } finally {
        leaseActive = false;
      }
    } catch (error) {
      log.warn(
        `review run failed: scoped=${scoped} model=${params.provider}/${params.model} ${describeReviewFailure(error)}`,
      );
      throw error;
    }
  } finally {
    preparedRunAdmission.close();
  }
}
