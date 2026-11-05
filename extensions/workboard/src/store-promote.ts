import type { WorkboardCard, WorkboardReviewState } from "@openclaw/workboard-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  appendComment,
  assertCanMutateClaimedCard,
  hasReviewMandatoryLabel,
} from "./store-card-helpers.js";
import { normalizeBoundedString } from "./store-coercion.js";
import { WorkboardEnrichmentStore } from "./store-enrichment.js";
import type {
  WorkboardAcceptInput,
  WorkboardMutationScope,
  WorkboardPromoteInput,
} from "./store-inputs.js";
import { clearDiagnostics } from "./store-normalizers.js";

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
          if (
            current.status === "review" &&
            target === "done" &&
            current.metadata?.acceptance !== "accepted"
          ) {
            throw new Error(
              "Moving a card from review to done requires acceptance accepted. Accept the review first.",
            );
          }
          // A verdict without a recorded completer can only come from pre-upgrade data. Closing on it
          // would accept work whose author was never established, so the move is refused for the
          // same reason accept() refuses: the identity is missing, not unknown.
          if (
            current.status === "review" &&
            target === "done" &&
            !current.metadata?.review?.completedBy
          ) {
            throw new Error(
              "Cannot close: this card has no recorded completer (pre-upgrade). Complete it once so the reviewer identity can be established.",
            );
          }
          // High-risk work needs two independent verdicts: one reviewer is a review, not a
          // second pair of eyes. Distinctness is what counts, so a repeated accept by the same
          // agent cannot satisfy this.
          if (
            current.status === "review" &&
            target === "done" &&
            hasReviewMandatoryLabel(current)
          ) {
            const recordedVerdicts = current.metadata?.review?.verdicts ?? [];
            // P1 recorded one reviewer in `acceptedBy` before verdicts existed. Reading it as a
            // first verdict keeps every card accepted before this rule from being stranded: it
            // needs exactly one more reviewer, not a rewrite of its history.
            const legacyReviewer = normalizeOptionalString(current.metadata?.acceptedBy);
            const reviewers = [
              ...new Set([
                ...recordedVerdicts.map((verdict) => verdict.reviewer),
                ...(legacyReviewer ? [legacyReviewer] : []),
              ]),
            ];
            if (reviewers.length < 2) {
              throw new Error(
                `High-risk work requires two independent reviewer verdicts before done; recorded ${reviewers.length}${reviewers.length ? ` (${reviewers.join(", ")})` : ""}.`,
              );
            }
            // Verdicts are bound to content: two reviewers looking at different trees did not
            // review the same thing, and the card must not close on that. A pre-artifact verdict
            // carries no artifact and takes no part in the comparison; report the conflicting
            // pair (first by `at`) rather than the whole set, so the message stays readable.
            const withArtifact = recordedVerdicts
              .filter((verdict) => verdict.artifact)
              .toSorted((left, right) => left.at - right.at);
            const first = withArtifact[0];
            const conflict = withArtifact.find((verdict) => verdict.artifact !== first?.artifact);
            if (conflict) {
              const detail = `${first?.reviewer}@${first?.artifact} vs ${conflict.reviewer}@${conflict.artifact}`;
              throw new Error(
                `High-risk work requires every verdict to name the same artifact before done; recorded ${detail}.`,
              );
            }
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
          }
          // Only accept() records the acceptance verdict; review to done leaves it untouched
          // and keeps the move reason as a comment.
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
                review?.status === "rejected" ? `Review rejected: ${reason}` : reason,
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

  async accept(
    id: string,
    input: WorkboardAcceptInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return (await this.acceptWithOutcome(id, input, scope)).card;
  }

  /** accept(), plus whether this call recorded a verdict or found one already there. A retry and
   * a duplicate are indistinguishable at the store, so the difference has to be reported rather
   * than refused: a client that never saw the first response must be able to retry safely. */
  async acceptWithOutcome(
    id: string,
    input: WorkboardAcceptInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<{ card: WorkboardCard; recorded: boolean }> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope ?? undefined);
      if (existing.status !== "review") {
        throw new Error(`Cannot accept Workboard card in ${existing.status}; expected review.`);
      }
      const reviewer = normalizeOptionalString(scope?.ownerId);
      if (!reviewer) {
        throw new Error("Acceptance requires a reviewer identity (scope ownerId).");
      }
      // Self-accept must compare against the agent that actually completed the card.
      // review.actor moves (accept overwrites it, a rejection overwrites it), so it can never
      // answer "who completed this". Only review.completedBy can, and it is written once by
      // complete().
      //
      // A missing completer is NOT an unknown completer. Pre-upgrade cards have no recorded
      // identity, and guessing one from actor would hand the card back to exactly the agent the
      // gate exists to block. So the accept is refused until the card has been completed once.
      const completer = existing.metadata?.review?.completedBy;
      if (!completer) {
        throw new Error(
          "Cannot accept: this card has no recorded completer (pre-upgrade). Complete it once so the reviewer identity can be established.",
        );
      }
      if (completer === reviewer) {
        throw new Error(
          "The worker that completed this card cannot accept its own work; a separate reviewer is required.",
        );
      }
      const now = Date.now();
      const reason = normalizeBoundedString(input.reason, undefined, 1000, "acceptance reason");
      const recorded = existing.metadata?.review?.verdicts ?? [];
      const highRisk = hasReviewMandatoryLabel(existing);
      const artifact = normalizeBoundedString(
        input.artifact,
        undefined,
        200,
        "acceptance artifact",
      );
      if (highRisk && !artifact) {
        throw new Error(
          "Accepting a high-risk card requires an artifact naming what was reviewed: for repository work the tree hash from `git rev-parse HEAD^{tree}`, otherwise a stable identifier your lane controls.",
        );
      }
      // Uniqueness lives at the write. A card accepted before verdicts existed carries one
      // reviewer in `acceptedBy`; that reviewer is materialised as a verdict here, once, so the
      // record survives the next accept overwriting the pointer — and so the same agent cannot
      // accept again under a fresh artifact.
      const legacyReviewer = normalizeOptionalString(existing.metadata?.acceptedBy);
      if (recorded.length === 0 && legacyReviewer === reviewer) {
        throw new Error(
          "This reviewer already accepted this review attempt (recorded as acceptedBy); the second verdict must come from a different agent.",
        );
      }
      const priorVerdicts =
        recorded.length === 0 && legacyReviewer
          ? [
              {
                reviewer: legacyReviewer,
                at: existing.metadata?.acceptedAt ?? now,
              },
            ]
          : recorded;
      // The idempotency key is (reviewer, artifact), not the reviewer alone. Deduping by
      // reviewer would keep an old artifact on file after a fix: reviewer A accepts at X,
      // findings, fix to Y, A re-accepts at Y and the entry still says X, so B's verdict at Y
      // makes the card permanently unclosable and A cannot clear it.
      const prior = priorVerdicts.find((verdict) => verdict.reviewer === reviewer);
      if (prior && prior.artifact === artifact) {
        // A retry: write nothing at all. Rewriting acceptedAt would postpone the
        // accepted_without_closure diagnostic for as long as the client keeps retrying.
        return { card: existing, recorded: false };
      }
      const verdict = { reviewer, at: now, ...(artifact ? { artifact } : {}) };
      const verdicts = prior
        ? priorVerdicts.map((entry) => (entry.reviewer === reviewer ? verdict : entry))
        : [...priorVerdicts, verdict];
      const review: WorkboardReviewState = {
        ...(existing.metadata?.review ?? { required: true, status: "pending", at: now }),
        required: true,
        status: "accepted",
        ...(reason ? { reason } : {}),
        actor: reviewer,
        verdicts,
        at: now,
      };
      const card = await this.updateCard(existing, {
        metadata: {
          ...existing.metadata,
          acceptance: "accepted",
          acceptedBy: reviewer,
          acceptedAt: now,
          review,
          comments: appendComment(
            existing.metadata?.comments,
            reason ? `Review accepted: ${reason}` : undefined,
            now,
          ),
        },
      });
      return { card, recorded: true };
    });
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
