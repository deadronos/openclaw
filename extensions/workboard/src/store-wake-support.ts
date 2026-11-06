import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { WorkboardWakeScheduler } from "./wake-scheduler.js";

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

/** A card write has already been decided, so a stale or unreachable job never fails it. */
export async function cancelWorkboardWake(
  scheduler: WorkboardWakeScheduler | undefined,
  cardId: string,
  jobId: string,
): Promise<void> {
  try {
    if (!scheduler) {
      throw new Error("no scheduler in this process");
    }
    await scheduler.cancel(jobId);
  } catch (error) {
    log.warn(
      `workboard wake for card ${cardId} (job ${jobId}) was not cancelled and may still fire: ${String(error)}`,
    );
  }
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
