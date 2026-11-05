import type { WorkboardReviewState } from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeBoundedString,
  normalizeEnumValue,
  normalizeTimestamp,
} from "./store-coercion.js";

export function normalizeReviewState(value: unknown): WorkboardReviewState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const status = normalizeEnumValue(
    value.status,
    ["pending", "accepted", "rejected", "skipped"] as const,
    "pending",
  );
  const reason = normalizeBoundedString(value.reason, undefined, 1000, "review reason");
  const actor = normalizeBoundedString(value.actor, undefined, 120, "review actor");
  // completedBy is the completion-time identity; actor moves on every review action.
  const completedBy = normalizeBoundedString(
    value.completedBy,
    undefined,
    120,
    "review completed by",
  );
  return {
    required: value.required === true,
    status,
    ...(reason ? { reason } : {}),
    ...(actor ? { actor } : {}),
    ...(completedBy ? { completedBy } : {}),
    at: normalizeTimestamp(value.at, Date.now()),
  };
}
