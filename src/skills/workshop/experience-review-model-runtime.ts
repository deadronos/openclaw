import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import { withPreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
} from "../../agents/prepared-model-runtime.js";
import type {
  PreparedModelRuntimeLease,
  PreparedReplyDispatchRuntime,
} from "../../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";

const log = createSubsystemLogger("skills/workshop");

export type ExperienceReviewModelRuntimeRequest = {
  config: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  provider?: string;
  model?: string;
  abortSignal: AbortSignal;
};

function describeLease(
  lease: PreparedModelRuntimeLease | undefined,
  published: PreparedReplyDispatchRuntime | undefined,
): string {
  const entries = lease?.snapshot.modelCatalog?.entries;
  return [
    `scoped=${lease ? "lease" : "none"}`,
    `published=${published ? "yes" : "no"}`,
    entries
      ? `catalogEntries=${entries.length} hasOpencodeGo=${entries.some((entry) => entry.provider === "opencode-go")}`
      : "catalog=n/a",
  ].join(" ");
}

/**
 * Runs a detached experience review against its own prepared model runtime.
 *
 * The review forks after the foreground turn closed, so it no longer inherits the
 * turn's plugin generation scope. Without an explicit lease the nested embedded
 * run resolves against a runtime prepared without the admitted generation and
 * fails with `Unknown model` for plugin-owned models such as `opencode-go`.
 */
export async function runWithExperienceReviewModelRuntime<T>(
  request: ExperienceReviewModelRuntimeRequest,
  run: () => Promise<T>,
): Promise<T> {
  const { config, agentId, workspaceDir, provider, model, abortSignal } = request;
  // Mirror the admitted-run and cron callers: bind the published reply dispatch
  // generation so a derived owner shares the gateway's warm plugin facts. A
  // detached acquisition without it publishes a colder generation whose catalog
  // cannot resolve plugin-only models.
  let publishedRuntime: PreparedReplyDispatchRuntime | undefined;
  try {
    publishedRuntime = await loadPublishedGatewayReplyDispatchRuntime({ agentId, abortSignal });
  } catch (error) {
    log.warn(`review model runtime published generation unavailable: ${formatErrorMessage(error)}`);
  }
  let lease: PreparedModelRuntimeLease | undefined;
  try {
    lease = await acquireAgentRunPreparedModelRuntime(
      {
        config,
        agentId,
        agentDir: resolveAgentDir(config, agentId),
        workspaceDir,
        // Owner-key alignment: the gateway's configured generation is published
        // with this set. Without it the lease cannot reuse that generation.
        allowGatewaySubagentBinding: true,
        ...(provider && model
          ? { runtimePluginSelections: [{ provider, modelId: model, agentId }] }
          : {}),
      },
      {
        catalogMode: "static",
        ...(publishedRuntime ? { pluginGeneration: publishedRuntime.pluginGeneration } : {}),
        abortSignal,
      },
    );
  } catch (error) {
    log.warn(`review model runtime lease failed: ${formatErrorMessage(error)}`);
  }
  log.info(
    `review model runtime: model=${provider ?? "?"}/${model ?? "?"} ${describeLease(lease, publishedRuntime)}`,
  );
  // A missing lease degrades to an unscoped run rather than failing the review:
  // the review prompt itself is still valid, only plugin-owned models are lost.
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
}
