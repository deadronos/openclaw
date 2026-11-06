import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { WorkboardWakeScheduler } from "./wake-scheduler.js";

const log = createSubsystemLogger("workboard");

/** A card write has already been decided, so a stale or unreachable job never fails it. */
export async function cancelWorkboardWake(
  scheduler: WorkboardWakeScheduler | undefined,
  jobId: string,
): Promise<void> {
  try {
    if (!scheduler) {
      throw new Error("no scheduler in this process");
    }
    await scheduler.cancel(jobId);
  } catch (error) {
    log.warn(`workboard wake ${jobId} was not cancelled and may still fire: ${String(error)}`);
  }
}
