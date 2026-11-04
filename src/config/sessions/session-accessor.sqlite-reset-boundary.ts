import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { clearSessionProgressCardForReset } from "../../session-cards/progress-card-store.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import {
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { SessionResetBoundaryWrite } from "./session-accessor.lifecycle-types.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { buildSessionResetBoundaryEvent } from "./session-reset-boundary-event.js";
import { resolveResetBoundaryHeaderCwd } from "./transcript-header.js";
import type { InternalSessionEntry } from "./types.js";

/** Transcript reset and prior-task retirement share the owning guarded transaction. */
export function appendSessionResetBoundary(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  previousEntry: InternalSessionEntry,
  boundary: SessionResetBoundaryWrite,
  projection?: {
    scheduleProjectionReconcile?: boolean;
    onProjectionReconcileNeeded?: () => void;
  },
): boolean {
  // Reset may be the first append; a headerless window cannot be read on the next turn.
  ensureTranscriptHeader(
    database,
    scope,
    resolveResetBoundaryHeaderCwd(previousEntry, boundary.cwd),
    projection,
  );
  const navigation = loadTranscriptEventsFromDatabase(database, scope.sessionId, {
    projection: "reset-boundary",
  });
  // Navigation omits placement data and result identity, and compressed rows persist that shape.
  const needsStoredEvents =
    boundary.context === "preserve-tail" &&
    navigation.some(
      (event) => asOptionalRecord(event)?.customType === BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE,
    );
  const event = buildSessionResetBoundaryEvent({
    events: needsStoredEvents
      ? loadTranscriptEventsFromDatabase(database, scope.sessionId)
      : navigation,
    ...boundary,
  });
  if (appendTranscriptEventInTransaction(database, scope, event, projection) === false) {
    throw new Error("Failed to append reset boundary for " + scope.sessionKey);
  }
  if (
    boundary.context === "clear" &&
    clearSessionProgressCardForReset(database.db, scope.sessionKey)
  ) {
    const { agentId, sessionKey } = scope;
    deferOpenClawAgentPostCommitPublication(database, () => {
      emitSessionLifecycleEvent({ agentId, sessionKey, reason: "progress-card-reset" });
    });
    return true;
  }
  return false;
}
