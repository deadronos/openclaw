import type { WorkboardReviewState } from "@openclaw/workboard-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { assertCanMutateClaimedCard, cardBoardId } from "./store-card-helpers.js";
import { normalizeBoundedString } from "./store-coercion.js";
import type {
  WorkboardHandoffInput,
  WorkboardHandoffResult,
  WorkboardMutationScope,
} from "./store-inputs.js";
import { capText, clearDiagnostics } from "./store-normalizers.js";
import { WorkboardNotificationStore } from "./store-notifications.js";
import { finishRun } from "./store-status-write.js";

export class WorkboardHandoffStore extends WorkboardNotificationStore {
  async handoff(
    id: string,
    input: WorkboardHandoffInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
  ): Promise<WorkboardHandoffResult> {
    return await this.enqueueMutation(() => this.handoffDirect(id, input, scope));
  }

  // Order: create -> link -> close. A throw anywhere after the destination exists leaves the
  // source open and visible; the one state this must never produce is a closed source whose
  // work is unlinked and unreachable.
  private async handoffDirect(
    id: string,
    input: WorkboardHandoffInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
  ): Promise<WorkboardHandoffResult> {
    const toAgent = normalizeBoundedString(input.toAgent, undefined, 120, "handoff agent");
    if (!toAgent) {
      throw new Error("toAgent must be a non-empty string to hand off a card.");
    }
    const note = normalizeBoundedString(input.note, undefined, 800, "handoff note");
    const existing = await this.requireCard(id);
    if (!existing.metadata?.claim) {
      throw new Error("card must be claimed before handoff.");
    }
    assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
    if (existing.metadata.acceptance === "accepted") {
      throw new Error(
        "card is already accepted; close accepted work with the normal completion path instead of a handoff.",
      );
    }
    const worker = normalizeOptionalString(scope?.ownerId) ?? existing.metadata.claim.ownerId;
    const handoffLine = note ? `Handed off to ${toAgent}: ${note}` : `Handed off to ${toAgent}`;
    const destination = await this.createDirect(
      {
        title: existing.title,
        notes: capText(existing.notes ? `${existing.notes}\n\n${handoffLine}` : handoffLine, 4000),
        status: "ready",
        agentId: toAgent,
        // Inherited labels keep a handoff from stripping the review obligation.
        labels: existing.labels,
        boardId: cardBoardId(existing),
        tenant: existing.metadata?.automation?.tenant,
      },
      scope === null ? undefined : scope,
    );
    const now = Date.now();
    // Link while the source is still open. The destination may be held at todo by the parent
    // dependency; it is promoted again once the source closes, below.
    await this.linkCardsDirect(existing.id, destination.id, now, scope === null ? {} : { scope });
    // The review gate stays explicit: this skip is recorded, attributed, and visible.
    // Both identities are in the reason: the agent handing off and the agent receiving.
    const handoffReason = `handed off by ${worker} to ${toAgent}${note ? `: ${note}` : ""}`;
    const review: WorkboardReviewState = {
      required: true,
      status: "skipped",
      reason: handoffReason,
      actor: worker,
      at: now,
    };
    // Re-read: the link step above updated the source's own links, so the pre-link snapshot
    // would fail the compare-and-set on close.
    const sourceNow = await this.requireCard(existing.id);
    const finished = finishRun(sourceNow, "done", now);
    const source = await this.updateCard(
      sourceNow,
      {
        ...finished,
        metadata: {
          ...clearDiagnostics(finished.metadata, ["missing_proof"]),
          review,
          closureReason: "handed_off_to",
        },
      },
      {
        enforceStatusHolds: true,
        event: { kind: "handoff", fromStatus: sourceNow.status, toStatus: "done" },
        eventAt: now,
      },
    );
    // The parent is done now, so a child held at todo by the dependency can become ready.
    const linkedDestination = await this.promoteDependencyReady(
      await this.requireCard(destination.id),
      now,
    );
    // Re-read so callers see the source as it is stored, child link included.
    return { source: await this.requireCard(source.id), destination: linkedDestination };
  }
}
