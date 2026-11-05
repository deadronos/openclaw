// Workboard review/acceptance gate tests: the review verdict and closure trail.
import { describe, expect, it } from "vitest";
import { createCard, expectRejected, expectStored } from "./store-family.test-support.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const createStore = () => createWorkboardSqliteTestStore({ createStores: createKernelStores });

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
      /closureReason is required.*delivered, rejected, cancelled, escalated, no-follow-on/,
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

    // The acceptance gate is not retroactive: a pre-existing review card still closes.
    const done = await store.move(legacyReview.id, "done", undefined, { ownerId: "reviewer" });
    expect(done.status).toBe("done");
  });
});
