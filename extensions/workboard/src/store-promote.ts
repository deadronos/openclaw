import type { WorkboardCard, WorkboardReviewState } from "@openclaw/workboard-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { appendComment, assertCanMutateClaimedCard } from "./store-card-helpers.js";
import { WorkboardEnrichmentStore } from "./store-enrichment.js";
import type { WorkboardMutationScope, WorkboardPromoteInput } from "./store-inputs.js";
import { clearDiagnostics, normalizeBoundedString } from "./store-normalizers.js";

export class WorkboardPromoteStore extends WorkboardEnrichmentStore {
  async move(
    id: string,
    status: unknown,
    position: unknown,
    scope?: WorkboardMutationScope,
    options: {
      expectedUpdatedAt?: number;
      assertOwnerCurrent?: () => void;
      reason?: unknown;
    } = {},
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(
        id,
        (current) => {
          // Recheck after every cross-host CAS conflict so a worker cannot move
          // a card claimed between the read and write.
          assertCanMutateClaimedCard(current, scope);
          const target = typeof status === "string" ? status : undefined;
          const reason = normalizeBoundedString(options.reason, undefined, 1000, "move reason");
          const now = Date.now();
          if (target === "done" && current.status === "running") {
            throw new Error(
              "This card must go through review before done. Complete it to review, or skip review explicitly for a small task.",
            );
          }
          if (current.status === "review" && target === "running" && !reason) {
            throw new Error(
              "A rejection reason is required when moving a card from review back to running.",
            );
          }
          const actor = normalizeOptionalString(scope?.ownerId);
          let review: WorkboardReviewState | undefined;
          if (current.status === "review" && target === "running") {
            review = {
              ...(current.metadata?.review ?? { required: true, status: "pending", at: now }),
              required: true,
              status: "rejected",
              reason,
              ...(actor ? { actor } : {}),
              at: now,
            };
          } else if (current.status === "review" && target === "done") {
            review = {
              ...(current.metadata?.review ?? { required: true, status: "pending", at: now }),
              required: true,
              status: "accepted",
              ...(reason ? { reason } : {}),
              ...(actor ? { actor } : {}),
              at: now,
            };
          }
          if (!review && !reason) {
            return { status, position };
          }
          return {
            status,
            position,
            metadata: {
              ...current.metadata,
              comments: appendComment(
                current.metadata?.comments,
                review?.status === "rejected"
                  ? `Review rejected: ${reason}`
                  : review?.status === "accepted" && reason
                    ? `Review accepted: ${reason}`
                    : reason,
                now,
              ),
              ...(review ? { review } : {}),
            },
          };
        },
        {
          allowMetadataDependencyLinks: false,
          enforceStatusHolds: true,
          expectedUpdatedAt: options.expectedUpdatedAt,
        },
      );
      return result.card;
    }, options.assertOwnerCurrent);
  }

  async promote(
    id: string,
    input: WorkboardPromoteInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const reason = normalizeBoundedString(input.reason, undefined, 1000, "promote reason");
      const result = await this.updateLatestCard(
        id,
        (current) => {
          if (current.status !== "todo") {
            throw new Error(`Cannot promote Workboard card in ${current.status}; expected todo.`);
          }
          assertCanMutateClaimedCard(current, scope === null ? undefined : scope);
          return {
            status: "ready",
            metadata: {
              ...clearDiagnostics(current.metadata, ["stranded_ready", "blocked_too_long"]),
              comments: appendComment(current.metadata?.comments, reason),
              stale: null,
            },
          };
        },
        { enforceStatusHolds: input.force !== true },
      );
      return result.card;
    });
  }
}
