import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { WorkboardWakeRequest, WorkboardWakeScheduler } from "./wake-scheduler.js";

const log = createSubsystemLogger("workboard");

/** Cleared together wherever a card leaves `blocked`. */
export const CLEARED_WAKE_STATE = {
  blockedOn: undefined,
  wakeAt: undefined,
  wakeJobId: undefined,
  wakeInMinutes: undefined,
} as const;

/** Re-arm interval for a consumed wake that never recorded one. */
export const DEFAULT_WORKBOARD_WAKE_MINUTES = 60;

/**
 * A card write has already been decided, so a stale or unreachable job never fails it.
 * Returns true when the job is gone, false when it could not be removed.
 */
export async function cancelWorkboardWake(
  scheduler: WorkboardWakeScheduler | undefined,
  cardId: string,
  jobId: string,
): Promise<boolean> {
  try {
    if (!scheduler) {
      throw new Error("no scheduler in this process");
    }
    await scheduler.cancel(jobId);
    return true;
  } catch (error) {
    log.warn(
      `workboard wake for card ${cardId} (job ${jobId}) was not cancelled and may still fire: ${String(error)}`,
    );
    return false;
  }
}

/**
 * Leaves at most one live job for a card: update in place, else cancel and arm. When the old job
 * can be neither moved nor removed it stays, with `replaced: false`; one live wake beats two.
 * Rejects only when no job remains, meaning the old one is gone and arming the new one failed.
 */
export async function armOrReplaceWorkboardWake(
  scheduler: WorkboardWakeScheduler | undefined,
  previousJobId: string | undefined,
  request: WorkboardWakeRequest,
): Promise<{ jobId: string; replaced: boolean }> {
  if (previousJobId) {
    try {
      if (!scheduler) {
        throw new Error("no scheduler in this process");
      }
      await scheduler.update(previousJobId, request);
      return { jobId: previousJobId, replaced: true };
    } catch (error) {
      // Expected for a consumed wake, so only the cancel outcome below warrants a warning.
      log.info(`workboard wake ${previousJobId} was not updated in place: ${String(error)}`);
    }
    if (!(await cancelWorkboardWake(scheduler, request.cardId, previousJobId))) {
      return { jobId: previousJobId, replaced: false };
    }
  }
  if (!scheduler) {
    throw new Error("no scheduler in this process");
  }
  return { jobId: await scheduler.arm(request), replaced: true };
}

/** Only a scheduler that answers can call a wake consumed; re-arming on a guess could duplicate. */
export async function isWorkboardWakeLive(
  scheduler: WorkboardWakeScheduler | undefined,
  cardId: string,
  jobId: string,
): Promise<boolean> {
  try {
    if (!scheduler) {
      throw new Error("no scheduler in this process");
    }
    return await scheduler.isLive(jobId);
  } catch (error) {
    log.warn(
      `workboard wake for card ${cardId} (job ${jobId}) could not be checked; keeping it: ${String(error)}`,
    );
    return true;
  }
}
