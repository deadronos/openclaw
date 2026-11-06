import type { WorkboardBlockedOn } from "@openclaw/workboard-contract";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginService } from "../api.js";

export type WorkboardWakeRequest = {
  cardId: string;
  title: string;
  ownerId: string;
  blockedOn?: WorkboardBlockedOn;
  reason: string;
  at: number;
};

export type WorkboardWakeScheduler = {
  /** Creates one job and returns its id. Rejects when no job could be created. */
  arm: (request: WorkboardWakeRequest) => Promise<string>;
  /** Removing a job that no longer exists is a no-op. */
  cancel: (jobId: string) => Promise<void>;
  /** False once the job has fired and gone, or can no longer fire. Rejects when unreachable. */
  isLive: (jobId: string) => Promise<boolean>;
};

type WakeOwner = Pick<Parameters<OpenClawPluginService["start"]>[0], "logger" | "getCron">;

type LaneBinding = {
  agentId?: string;
  match?: { channel?: string; peer?: { kind?: string; id?: string } };
};

const WORKBOARD_WAKE_STATE_KEY = Symbol.for("openclaw.workboard.wakeState");

// Prepared model generations register fresh stores without starting their services, so the
// started service publishes its scheduler handle here for every generation's store to reach.
function wakeState(): { owner?: WakeOwner } {
  return resolveGlobalSingleton<{ owner?: WakeOwner }>(
    WORKBOARD_WAKE_STATE_KEY,
    () => ({}),
    (state) => {
      state.owner = undefined;
    },
  );
}

export function resolveWorkboardOwnerLane(
  config: { bindings?: readonly LaneBinding[] },
  ownerId: string,
): string | undefined {
  return config.bindings?.find(
    (binding) =>
      binding.agentId === ownerId &&
      binding.match?.channel === "discord" &&
      binding.match.peer?.kind === "channel",
  )?.match?.peer?.id;
}

export function buildWorkboardWakeJob(request: WorkboardWakeRequest, laneThreadId?: string) {
  const blocker = request.blockedOn
    ? `${request.blockedOn.kind} ${request.blockedOn.value}`
    : request.reason;
  return {
    name: `Workboard wake ${request.cardId}`,
    description: `Wake for blocked Workboard card ${request.cardId}.`,
    enabled: true,
    agentId: request.ownerId,
    schedule: { kind: "at" as const, at: new Date(request.at).toISOString() },
    sessionTarget: `session:agent:${request.ownerId}:main`,
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      // The job can outlive the card state when a CLI one-shot resolved it, hence the re-check.
      message: `Workboard card ${request.cardId} ("${request.title}") is blocked and awaiting resolution. Blocker: ${blocker}. Check it with workboard_read; if the card is no longer blocked, do nothing.`,
    },
    delivery: laneThreadId
      ? {
          mode: "announce" as const,
          channel: "discord",
          to: `channel:${laneThreadId}`,
          threadId: laneThreadId,
        }
      : // Omitting delivery would default to announcing on whatever route the session used last.
        { mode: "none" as const },
  };
}

export function createWorkboardWakeService(params: {
  currentConfig: () => { bindings?: readonly LaneBinding[] };
}): OpenClawPluginService & { stop: () => void; scheduler: WorkboardWakeScheduler } {
  let serviceOwner: WakeOwner | undefined;
  const requireCron = () => {
    const owner = wakeState().owner;
    const cron = owner?.getCron?.();
    if (!owner || !cron) {
      throw new Error("the Gateway scheduler is unavailable");
    }
    return { owner, cron };
  };
  return {
    id: "workboard-wake",
    start(ctx) {
      wakeState().owner = serviceOwner = { logger: ctx.logger, getCron: ctx.getCron };
    },
    stop() {
      const state = wakeState();
      if (state.owner === serviceOwner) {
        state.owner = undefined;
      }
      serviceOwner = undefined;
    },
    scheduler: {
      arm: async (request) => {
        const { owner, cron } = requireCron();
        const lane = resolveWorkboardOwnerLane(params.currentConfig(), request.ownerId);
        if (!lane) {
          owner.logger.warn(
            `workboard wake for card ${request.cardId}: no Discord lane bound to ${request.ownerId}; the wake reaches the session only`,
          );
        }
        const job = await cron.add(buildWorkboardWakeJob(request, lane));
        if (!isRecord(job) || typeof job.id !== "string") {
          throw new Error("the scheduler did not return a job id");
        }
        return job.id;
      },
      cancel: async (jobId) => {
        const { cron } = requireCron();
        const job = (await cron.list({ includeDisabled: true })).find(({ id }) => id === jobId);
        // A woken agent resolving its own card lands here while its job runs. Removal would be
        // recorded as an operator cancellation of that run; the one-shot deletes itself anyway.
        if (!job || job.state?.runningAtMs !== undefined) {
          return;
        }
        await cron.remove(jobId);
      },
      isLive: async (jobId) => {
        const { cron } = requireCron();
        const job = (await cron.list({ includeDisabled: true })).find(({ id }) => id === jobId);
        return job !== undefined && job.enabled !== false;
      },
    },
  };
}
