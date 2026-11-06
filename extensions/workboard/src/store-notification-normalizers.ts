import { randomUUID } from "node:crypto";
import {
  WORKBOARD_NOTIFICATION_KINDS,
  type WorkboardNotificationKind,
  type WorkboardNotificationSubscription,
} from "@openclaw/workboard-contract";
import { definedFields } from "../record-fields.js";
import { normalizeBoundedString } from "./store-coercion.js";
import type { WorkboardNotificationSubscribeInput } from "./store-inputs.js";
import { normalizeBoardId, normalizeRunId } from "./store-normalizers.js";

function normalizeNotificationKinds(value: unknown): WorkboardNotificationKind[] | undefined {
  if (value == null) {
    return undefined;
  }
  const entries = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const kinds: WorkboardNotificationKind[] = [];
  for (const entry of entries) {
    const kind = typeof entry === "string" ? entry.trim() : "";
    if (!WORKBOARD_NOTIFICATION_KINDS.includes(kind as WorkboardNotificationKind)) {
      throw new Error(
        `notification kind must be one of: ${WORKBOARD_NOTIFICATION_KINDS.join(", ")}.`,
      );
    }
    const notificationKind = kind as WorkboardNotificationKind;
    if (!kinds.includes(notificationKind)) {
      kinds.push(notificationKind);
    }
  }
  return kinds.length ? kinds : undefined;
}

export function normalizeNotificationSubscription(
  input: WorkboardNotificationSubscribeInput,
): WorkboardNotificationSubscription {
  const now = Date.now();
  const boardId = normalizeBoardId(input.boardId) ?? "default";
  const cardId = normalizeBoundedString(input.cardId, undefined, 120, "card id");
  const sessionKey = normalizeBoundedString(input.sessionKey, undefined, 240, "session key");
  const runId = normalizeRunId(input.runId);
  const target = normalizeBoundedString(input.target, undefined, 240, "notification target");
  if (!cardId && !sessionKey && !runId && !target) {
    throw new Error("notification subscription needs cardId, sessionKey, runId, or target.");
  }
  const eventKinds = normalizeNotificationKinds(input.eventKinds);
  return definedFields({
    id: randomUUID(),
    boardId,
    cardId,
    sessionKey,
    runId,
    target,
    eventKinds,
    createdAt: now,
    updatedAt: now,
  });
}
