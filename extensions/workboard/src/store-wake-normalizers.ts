import { WORKBOARD_BLOCKER_KINDS, type WorkboardBlockedOn } from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeBoundedString } from "./store-coercion.js";

export function normalizeBlockedOn(value: unknown): WorkboardBlockedOn | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = isRecord(value) ? value : {};
  const kind = WORKBOARD_BLOCKER_KINDS.find((candidate) => candidate === record.kind);
  const target = normalizeBoundedString(record.value, undefined, 400, "blocker value");
  if (!kind || !target) {
    throw new Error("blockedOn requires kind (card, person, or artifact) and a non-empty value.");
  }
  return { kind, value: target };
}

export function readWakeInMinutes(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("wakeInMinutes must be an integer of at least 1.");
  }
  return value;
}
