// Workboard review/acceptance gate tests: the review verdict and closure trail.
import { describe, expect, it } from "vitest";
import { createCard, expectRejected, expectStored } from "./store-family.test-support.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const createStore = () => createWorkboardSqliteTestStore({ createStores: createKernelStores });

async function acceptedReviewCard(store: ReturnType<typeof createStore>) {
  const card = await createCard(store, "Accepted review", { status: "running" });
  await store.claim(card.id, { ownerId: "worker", token: "token-accepted" });
  await store.complete(card.id, {
    ownerId: "worker",
    token: "token-accepted",
    summary: "Ready for review.",
    closureReason: "delivered",
  });
  await store.accept(card.id, {}, { ownerId: "reviewer" });
  return card;
}

describe("Workboard review and acceptance gate", () => {
  it("refuses completion without a closure reason", async () => {
    const store = createStore();
    const card = await createCard(store, "Missing closure reason", { status: "running" });
    await store.claim(card.id, { ownerId: "worker", token: "token-closure" });

    await expectRejected(
      store.complete(card.id, {
        ownerId: "worker",
        token: "token-closure",
        summary: "Done.",
      }),
      /closureReason is required.*delivered, handed_off_to, rejected, cancelled, escalated, no-follow-on/,
    );
    await expectStored(store, card.id, { status: "running" });
  });

  it("refuses review to done without an accepted verdict", async () => {
    const store = createStore();
    const card = await createCard(store, "Unaccepted change", { status: "running" });
    await store.claim(card.id, { ownerId: "worker", token: "token-unaccepted" });
    await store.complete(card.id, {
      ownerId: "worker",
      token: "token-unaccepted",
      summary: "Ready.",
      closureReason: "delivered",
    });

    await expectRejected(
      store.move(card.id, "done", undefined, { ownerId: "reviewer" }),
      "requires acceptance accepted",
    );
    await expectStored(store, card.id, { status: "review" });
  });

  it("refuses self-acceptance and records the reviewer verdict", async () => {
    const store = createStore();
    const card = await createCard(store, "Self acceptance", { status: "running" });
    await store.claim(card.id, { ownerId: "worker", token: "token-self" });
    await store.complete(card.id, {
      ownerId: "worker",
      token: "token-self",
      summary: "Ready.",
      closureReason: "delivered",
    });

    await expectRejected(
      store.accept(card.id, {}, { ownerId: "worker" }),
      "cannot accept its own work",
    );
    await expectRejected(store.accept(card.id), "requires a reviewer identity");
    const accepted = await store.accept(card.id, {}, { ownerId: "reviewer" });
    expect(accepted.metadata).toMatchObject({
      acceptance: "accepted",
      acceptedBy: "reviewer",
      closureReason: "delivered",
      review: { status: "accepted", actor: "reviewer" },
    });
    expect(accepted.metadata?.acceptedAt).toBeGreaterThan(0);
  });

  it("completes, accepts, and closes a trial card", async () => {
    const store = createStore();
    const card = await createCard(store, "Trial card", { status: "running", labels: ["code"] });
    await store.claim(card.id, { ownerId: "worker", token: "token-trial" });

    const completed = await store.complete(card.id, {
      ownerId: "worker",
      token: "token-trial",
      summary: "Trial delivered.",
      proof: { status: "passed", command: "pnpm test" },
      closureReason: "delivered",
    });
    expect(completed.status).toBe("review");
    expect(completed.metadata).toMatchObject({ closureReason: "delivered", acceptance: "pending" });

    const accepted = await store.accept(
      card.id,
      { reason: "Verified the trial card." },
      { ownerId: "reviewer" },
    );
    expect(accepted.metadata).toMatchObject({ acceptedBy: "reviewer", acceptance: "accepted" });

    const done = await store.move(card.id, "done", undefined, { ownerId: "reviewer" });
    expect(done.status).toBe("done");
    expect(done.completedAt).toBeGreaterThan(0);
    expect(done.metadata).toMatchObject({
      closureReason: "delivered",
      acceptance: "accepted",
      acceptedBy: "reviewer",
      review: { status: "accepted", actor: "reviewer" },
    });
    // Events stay append-only: creation through closure appends, never rewrites.
    // Entering review releases the worker claim, so the trail records both facts.
    expect(done.events?.map((event) => event.kind)).toEqual([
      "created",
      "claimed",
      "moved",
      "released",
      "comment_added",
      "moved",
    ]);
    expect(done.events?.at(-1)).toMatchObject({ kind: "moved", toStatus: "done" });
  });

  it("records a release as released and names the released owner", async () => {
    const store = createStore();
    const card = await createCard(store, "Released card", { status: "running" });
    await store.claim(card.id, { ownerId: "worker", token: "token-release" });

    const released = await store.releaseClaim(card.id, {
      ownerId: "worker",
      token: "token-release",
    });
    expect(released.metadata?.claim).toBeUndefined();
    expect(released.events?.at(-1)).toMatchObject({ kind: "released", ownerId: "worker" });
    expect(released.events?.filter((event) => event.kind === "claimed")).toHaveLength(1);

    // The released owner survives the round trip, not just the in-memory write.
    expect((await store.get(card.id))?.events?.at(-1)).toMatchObject({
      kind: "released",
      ownerId: "worker",
    });
  });

  it("releases the worker claim when completion enters review", async () => {
    const store = createStore();
    const card = await createCard(store, "Review handoff", { status: "running" });
    await store.claim(card.id, { ownerId: "worker", token: "token-handoff" });

    const completed = await store.complete(card.id, {
      ownerId: "worker",
      token: "token-handoff",
      summary: "Ready for review.",
      closureReason: "delivered",
    });
    expect(completed.status).toBe("review");
    expect(completed.metadata?.claim).toBeUndefined();
    expect(completed.events?.at(-1)).toMatchObject({ kind: "released", ownerId: "worker" });

    // No reclaim and no manual release: a second agent writes the verdict straight into review.
    const commented = await store.addComment(
      card.id,
      { body: "Reviewer note." },
      { ownerId: "reviewer" },
    );
    expect(commented.metadata?.comments?.at(-1)?.body).toBe("Reviewer note.");
    const proofed = await store.addProof(
      card.id,
      { status: "passed", command: "pnpm test" },
      { ownerId: "reviewer" },
    );
    expect(proofed.metadata?.proof?.at(-1)).toMatchObject({ status: "passed" });
  });

  it("releases the worker claim when a move enters review", async () => {
    const store = createStore();
    const card = await createCard(store, "Moved into review", { status: "running" });
    await store.claim(card.id, { ownerId: "worker", token: "token-move" });

    const moved = await store.move(card.id, "review", undefined, {
      ownerId: "worker",
      token: "token-move",
    });
    expect(moved.metadata?.claim).toBeUndefined();
    expect(moved.events?.at(-1)).toMatchObject({ kind: "released", ownerId: "worker" });
    await expect(
      store.addComment(card.id, { body: "Reviewer note." }, { ownerId: "reviewer" }),
    ).resolves.toMatchObject({ status: "review" });
  });

  it("refuses review to done for a legacy card with no review metadata", async () => {
    const store = createStore();
    const card = await createCard(store, "Legacy review", { status: "review" });

    await expectRejected(
      store.move(card.id, "done", undefined, { ownerId: "mover" }),
      "requires acceptance accepted",
    );
    const stored = await store.get(card.id);
    expect(stored).toMatchObject({ status: "review" });
    // The refused close fabricates no verdict and no review state.
    expect(stored?.metadata?.review).toBeUndefined();
    expect(stored?.metadata?.acceptance).toBeUndefined();
    expect(stored?.metadata?.acceptedBy).toBeUndefined();
    expect(stored?.metadata?.acceptedAt).toBeUndefined();
  });

  it("closes a legacy review card only after it is completed and accepted", async () => {
    const store = createStore();
    const card = await createCard(store, "Legacy acceptance", { status: "review" });

    await expectRejected(
      store.move(card.id, "done", undefined, { ownerId: "reviewer" }),
      "requires acceptance accepted",
    );
    // Pre-upgrade card: no recorded completer, so no accept until it is completed once.
    await expectRejected(
      store.accept(card.id, {}, { ownerId: "reviewer" }),
      "has no recorded completer (pre-upgrade)",
    );

    await store.update(card.id, { status: "running" });
    await store.claim(card.id, { ownerId: "worker" });
    await store.complete(card.id, {
      ownerId: "worker",
      summary: "Completed after upgrade.",
      closureReason: "delivered",
    });
    await store.accept(card.id, {}, { ownerId: "reviewer" });
    const done = await store.move(
      card.id,
      "done",
      undefined,
      { ownerId: "mover" },
      { reason: "Checked." },
    );

    expect(done.status).toBe("done");
    expect(done.metadata).toMatchObject({
      acceptance: "accepted",
      acceptedBy: "reviewer",
      review: { required: true, status: "accepted", actor: "reviewer" },
    });
    // The mover neither becomes the review actor nor overwrites the verdict.
    expect(done.metadata?.review?.reason).toBeUndefined();
    expect(done.metadata?.comments?.at(-1)?.body).toBe("Checked.");
  });

  it("clears the acceptance verdict when review returns to running", async () => {
    const store = createStore();
    const card = await acceptedReviewCard(store);

    const reworked = await store.move(
      card.id,
      "running",
      undefined,
      { ownerId: "reviewer" },
      { reason: "Needs another pass." },
    );
    expect(reworked.metadata).toMatchObject({ review: { status: "rejected" } });

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("running");
    expect(stored?.metadata?.review).toMatchObject({ required: true, status: "rejected" });
    expect(stored?.metadata?.acceptance).toBeUndefined();
    expect(stored?.metadata?.acceptedBy).toBeUndefined();
    expect(stored?.metadata?.acceptedAt).toBeUndefined();

    await store.move(card.id, "review", undefined, { ownerId: "reviewer" });
    await expectRejected(
      store.move(card.id, "done", undefined, { ownerId: "reviewer" }),
      "requires acceptance accepted",
    );
  });

  it("clears the acceptance verdict when review moves to blocked", async () => {
    const store = createStore();
    const card = await acceptedReviewCard(store);

    await store.move(
      card.id,
      "blocked",
      undefined,
      { ownerId: "reviewer" },
      { reason: "Waiting on upstream." },
    );
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("blocked");
    expect(stored?.metadata?.review).toMatchObject({ required: true, status: "pending" });
    expect(stored?.metadata?.acceptance).toBeUndefined();
    expect(stored?.metadata?.acceptedBy).toBeUndefined();
    expect(stored?.metadata?.acceptedAt).toBeUndefined();

    await store.move(card.id, "review", undefined, { ownerId: "reviewer" });
    await expectRejected(
      store.move(card.id, "done", undefined, { ownerId: "reviewer" }),
      "requires acceptance accepted",
    );
  });

  it("clears the acceptance verdict when review moves to todo", async () => {
    const store = createStore();
    const card = await acceptedReviewCard(store);

    await store.move(card.id, "todo", undefined, { ownerId: "reviewer" });
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("todo");
    expect(stored?.metadata?.review).toMatchObject({ required: true, status: "pending" });
    expect(stored?.metadata?.acceptance).toBeUndefined();
    expect(stored?.metadata?.acceptedBy).toBeUndefined();
    expect(stored?.metadata?.acceptedAt).toBeUndefined();

    await store.move(card.id, "review", undefined, { ownerId: "reviewer" });
    await expectRejected(
      store.move(card.id, "done", undefined, { ownerId: "reviewer" }),
      "requires acceptance accepted",
    );
  });

  it("reads legacy cards without synthesizing closure or acceptance state", async () => {
    const store = createWorkboardSqliteTestStore();
    const closed = await store.create({ title: "Legacy closed card", status: "done" });
    const legacyReview = await store.create({ title: "Legacy review card", status: "review" });

    const stored = await store.get(closed.id);
    if (!stored) {
      throw new Error("legacy closed card was not stored");
    }
    expect(stored.status).toBe("done");
    expect(stored.metadata?.closureReason).toBeUndefined();
    expect(stored.metadata?.acceptance).toBeUndefined();
    expect(stored.metadata?.acceptedBy).toBeUndefined();
    expect(stored.metadata?.acceptedAt).toBeUndefined();
    // Absent, not "pending": the fields never appear on the wire for legacy rows.
    const wire = JSON.stringify(stored.metadata ?? {});
    expect(wire).not.toContain("closureReason");
    expect(wire).not.toContain("acceptance");

    // The acceptance gate is not retroactive but not bypassable either: a legacy review card
    // needs a real accept before it can close, and the refusal writes no verdict.
    await expectRejected(
      store.move(legacyReview.id, "done", undefined, { ownerId: "reviewer" }),
      "requires acceptance accepted",
    );
    const stillReview = await store.get(legacyReview.id);
    expect(stillReview?.status).toBe("review");
    expect(stillReview?.metadata?.review).toBeUndefined();
    expect(stillReview?.metadata?.acceptance).toBeUndefined();
  });

  it("resets a carried-over acceptance when a card enters review again", async () => {
    const store = createStore();
    const card = await createCard(store, "Carried verdict", { status: "running" });
    // Legacy shape: a verdict persisted while the card sits outside review.
    const seeded = await store.update(card.id, {
      metadata: {
        acceptance: "accepted",
        acceptedBy: "ghost-reviewer",
        acceptedAt: 1,
        review: { required: true, status: "accepted", actor: "ghost-reviewer", at: 1 },
      },
    });
    expect(seeded.metadata).toMatchObject({ acceptance: "accepted" });

    const entered = await store.move(card.id, "review", undefined, { ownerId: "mover" });
    expect(entered.metadata).toMatchObject({
      acceptance: "pending",
      review: { status: "pending" },
    });

    const stored = await store.get(card.id);
    expect(stored?.metadata?.acceptedBy).toBeUndefined();
    expect(stored?.metadata?.acceptedAt).toBeUndefined();

    await expectRejected(
      store.move(card.id, "done", undefined, { ownerId: "mover" }),
      "requires acceptance accepted",
    );
  });

  it("lets a reviewer who rejected a card accept it after the rework", async () => {
    const store = createStore();
    const card = await acceptedReviewCard(store);

    // Reviewer rejects: review -> running, which also voids the verdict.
    await store.move(
      card.id,
      "running",
      undefined,
      { ownerId: "reviewer" },
      { reason: "Needs a fix." },
    );
    await store.move(card.id, "review", undefined, { ownerId: "reviewer" });

    const accepted = await store.accept(card.id, {}, { ownerId: "reviewer" });
    expect(accepted.metadata).toMatchObject({
      acceptance: "accepted",
      acceptedBy: "reviewer",
      review: { completedBy: "worker", actor: "reviewer", status: "accepted" },
    });
  });

  it("still refuses the completer after another agent has touched the review", async () => {
    const store = createStore();
    const card = await acceptedReviewCard(store);

    await store.move(
      card.id,
      "running",
      undefined,
      { ownerId: "reviewer" },
      { reason: "Needs a fix." },
    );
    await store.move(card.id, "review", undefined, { ownerId: "reviewer" });

    // review.actor is now the reviewer; the completer is still recorded separately.
    await expectRejected(
      store.accept(card.id, {}, { ownerId: "worker" }),
      "cannot accept its own work",
    );
  });

  it("refuses accept for a legacy card with no recorded completer", async () => {
    const store = createStore();
    const card = await createCard(store, "Legacy pending", { status: "review" });
    await store.update(card.id, {
      metadata: { review: { required: true, status: "pending", actor: "worker", at: 1 } },
    });

    // Missing identity is not unknown identity: no actor fallback, a distinct message.
    await expectRejected(
      store.accept(card.id, {}, { ownerId: "worker" }),
      "has no recorded completer (pre-upgrade)",
    );
  });

  it("refuses the real completer on a legacy card rejected by someone else", async () => {
    const store = createStore();
    const card = await createCard(store, "Legacy rejected", { status: "review" });
    // Completed by A, rejected by B: actor points at B, so an actor fallback would let A in.
    await store.update(card.id, {
      metadata: { review: { required: true, status: "rejected", actor: "reviewer-b", at: 1 } },
    });

    await expectRejected(
      store.accept(card.id, {}, { ownerId: "worker-a" }),
      "has no recorded completer (pre-upgrade)",
    );

    // Once completed again, completedBy exists and the gate decides on facts, not guesses.
    await store.update(card.id, { status: "running" });
    await store.claim(card.id, { ownerId: "worker-a" });
    await store.complete(card.id, {
      ownerId: "worker-a",
      summary: "Completed after upgrade.",
      closureReason: "delivered",
    });
    await expectRejected(
      store.accept(card.id, {}, { ownerId: "worker-a" }),
      "cannot accept its own work",
    );
  });

  it("refuses to close a pre-upgrade card that only carries an old accepted verdict", async () => {
    const store = createStore();
    const card = await createCard(store, "Stale verdict", { status: "review" });
    // Pre-upgrade shape: a verdict with no recorded completer behind it.
    await store.update(card.id, {
      metadata: {
        acceptance: "accepted",
        acceptedBy: "ghost-reviewer",
        acceptedAt: 1,
        review: { required: true, status: "accepted", actor: "ghost-reviewer", at: 1 },
      },
    });

    await expectRejected(
      store.move(card.id, "done", undefined, { ownerId: "mover" }),
      "has no recorded completer (pre-upgrade)",
    );
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("review");
    expect(stored?.metadata?.acceptance).toBe("accepted");
  });
});
