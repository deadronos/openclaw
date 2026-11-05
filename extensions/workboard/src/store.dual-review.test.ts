// High-risk work needs two independent reviewer verdicts: one verdict is a review, not a second
// pair of eyes. The gate lives in move(review -> done) and is fed by accept().
//
// "Independent" is a property of identities, not of sessions: the same agent id in two sessions
// is one reviewer. Availability of reviewers is a dispatcher fact, so the store names what it has
// recorded and refuses; escalation stays with the dispatcher.
import { describe, expect, it } from "vitest";
import { createCard, expectRejected } from "./store-family.test-support.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const createStore = () => createWorkboardSqliteTestStore({ createStores: createKernelStores });
const TREE = "e2adeaa889f495ae89875b1a7e909e0ec918ce5c";

async function completedCard(
  store: ReturnType<typeof createStore>,
  input: { title: string; labels?: string[]; agentId?: string },
) {
  const card = await createCard(store, input.title, {
    status: "running",
    labels: input.labels,
    agentId: input.agentId,
  });
  await store.claim(card.id, { ownerId: "worker", token: "token-worker" });
  await store.complete(card.id, {
    ownerId: "worker",
    token: "token-worker",
    summary: "Ready for review.",
    closureReason: "delivered",
  });
  return card;
}

async function reworkViaMove(store: ReturnType<typeof createStore>, id: string) {
  await store.claim(id, { ownerId: "worker", token: "token-rework" });
  await store.move(
    id,
    "running",
    undefined,
    { ownerId: "worker", token: "token-rework" },
    { reason: "Rework requested by review." },
  );
  return await store.move(
    id,
    "review",
    undefined,
    { ownerId: "worker", token: "token-rework" },
    { reason: "Rework delivered." },
  );
}

describe("Workboard dual review for high-risk cards", () => {
  it("refuses review to done on a code card with one verdict", async () => {
    const store = createStore();
    const card = await completedCard(store, { title: "Touch code", labels: ["code"] });

    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-a" });
    await expectRejected(
      store.move(card.id, "done", undefined, { ownerId: "reviewer-a" }),
      "High-risk work requires two independent reviewer verdicts",
    );
    expect((await store.get(card.id))?.status).toBe("review");
  });

  it("closes a code card after two verdicts from distinct agents", async () => {
    const store = createStore();
    const card = await completedCard(store, { title: "Two pairs of eyes", labels: ["code"] });

    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-a" });
    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-b" });
    const done = await store.move(card.id, "done", undefined, { ownerId: "reviewer-b" });

    expect(done.status).toBe("done");
    const reviewers = (done.metadata?.review?.verdicts ?? []).map((verdict) => verdict.reviewer);
    expect(reviewers).toEqual(["reviewer-a", "reviewer-b"]);
  });

  it("keeps one agent to one verdict per artifact, across sessions", async () => {
    const store = createStore();
    const card = await completedCard(store, { title: "Same reviewer twice", labels: ["security"] });

    // Two sessions of the same agent are one reviewer: the second attempt records nothing.
    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-a" });
    const retry = await store.acceptWithOutcome(
      card.id,
      { artifact: TREE },
      { ownerId: "reviewer-a" },
    );
    expect(retry.recorded).toBe(false);

    await expectRejected(
      store.move(card.id, "done", undefined, { ownerId: "reviewer-a" }),
      "recorded 1 (reviewer-a)",
    );
  });

  it("reports a repeated accept as already recorded and moves no timestamp", async () => {
    const store = createStore();
    const card = await completedCard(store, { title: "Retried accept", labels: ["code"] });

    const first = await store.acceptWithOutcome(
      card.id,
      { artifact: TREE },
      { ownerId: "reviewer-a" },
    );
    expect(first.recorded).toBe(true);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    const again = await store.acceptWithOutcome(
      card.id,
      { artifact: TREE },
      { ownerId: "reviewer-a" },
    );
    expect(again.recorded).toBe(false);

    // A retry must not postpone accepted_without_closure by refreshing the acceptance age.
    expect(again.card.metadata?.acceptedAt).toBe(first.card.metadata?.acceptedAt);
    expect(again.card.metadata?.review?.at).toBe(first.card.metadata?.review?.at);
    expect(again.card.metadata?.review?.verdicts).toHaveLength(1);
  });

  it("replaces a verdict when the same reviewer accepts a new artifact", async () => {
    const store = createStore();
    const card = await completedCard(store, { title: "Re-review after a fix", labels: ["code"] });
    const fixed = "1111111111111111111111111111111111111111";

    const first = await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-a" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    const second = await store.accept(card.id, { artifact: fixed }, { ownerId: "reviewer-a" });

    const verdicts = second.metadata?.review?.verdicts ?? [];
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.artifact).toBe(fixed);
    expect(verdicts[0]?.at).toBeGreaterThan(first.metadata?.review?.verdicts?.[0]?.at ?? 0);
    // And the workflow stays closable: a second reviewer at the fixed artifact satisfies it.
    await store.accept(card.id, { artifact: fixed }, { ownerId: "reviewer-b" });
    const done = await store.move(card.id, "done", undefined, { ownerId: "reviewer-b" });
    expect(done.status).toBe("done");
  });

  it("names the reviewer count when it refuses the close", async () => {
    const store = createStore();
    const card = await completedCard(store, { title: "Blocked on reviewers", labels: ["deploy"] });

    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-a" });
    await expectRejected(
      store.move(card.id, "done", undefined, { ownerId: "reviewer-a" }),
      "High-risk work requires two independent reviewer verdicts before done; recorded 1 (reviewer-a).",
    );

    const blocked = await store.block(card.id, {
      reason:
        "Blocked: only one reviewer verdict recorded (reviewer-a); a second independent reviewer is required.",
    });
    expect(blocked.status).toBe("blocked");
    const comments = JSON.stringify(blocked.metadata?.comments ?? []);
    expect(comments).toContain("one reviewer verdict recorded");
  });

  it("refuses a high-risk accept that names no artifact", async () => {
    const store = createStore();
    const card = await completedCard(store, { title: "No artifact", labels: ["code"] });

    await expectRejected(
      store.accept(card.id, {}, { ownerId: "reviewer-a" }),
      "Accepting a high-risk card requires an artifact",
    );
    expect((await store.get(card.id))?.metadata?.review?.verdicts).toBeUndefined();
  });

  it("refuses the close when verdicts name different artifacts", async () => {
    const store = createStore();
    const card = await completedCard(store, { title: "Drifted artifacts", labels: ["code"] });

    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-a" });
    await store.accept(card.id, { artifact: "ffffffffffff" }, { ownerId: "reviewer-b" });

    await expectRejected(
      store.move(card.id, "done", undefined, { ownerId: "reviewer-b" }),
      `recorded reviewer-a@${TREE} vs reviewer-b@ffffffffffff`,
    );
  });

  it("refuses the worker who produced the work as a reviewer", async () => {
    const store = createStore();
    const card = await completedCard(store, { title: "Producer as reviewer", labels: ["code"] });

    await expectRejected(
      store.accept(card.id, { artifact: TREE }, { ownerId: "worker" }),
      "The worker that completed this card cannot accept its own work",
    );
    expect((await store.get(card.id))?.metadata?.review?.verdicts).toBeUndefined();
  });

  it("lets an assignee who did not produce the work review it", async () => {
    const store = createStore();
    // agentId is assignment, not authorship: after a handoff the assignee is the reviewer.
    const card = await completedCard(store, {
      title: "Handed off",
      labels: ["code"],
      agentId: "reviewer-a",
    });

    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-a" });
    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-b" });
    const done = await store.move(card.id, "done", undefined, { ownerId: "reviewer-b" });
    expect(done.status).toBe("done");
  });

  it("drops verdicts when the card is reworked through move", async () => {
    const store = createStore();
    const card = await completedCard(store, { title: "Rework", labels: ["code"] });
    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-a" });
    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-b" });

    const reworked = await reworkViaMove(store, card.id);
    expect(reworked.metadata?.review?.verdicts).toBeUndefined();

    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-a" });
    await expectRejected(
      store.move(card.id, "done", undefined, { ownerId: "reviewer-a" }),
      "recorded 1 (reviewer-a)",
    );
  });

  it("counts a pre-verdict acceptedBy as the first verdict", async () => {
    const store = createStore();
    // Seeded the way a pre-verdict card looks: acceptance recorded, no verdict list at all.
    const card = await createCard(store, "Legacy accepted", {
      status: "review",
      labels: ["code"],
      metadata: {
        acceptance: "accepted",
        acceptedBy: "reviewer-a",
        acceptedAt: 1_700_000_000_000,
        review: {
          required: true,
          status: "accepted",
          actor: "reviewer-a",
          completedBy: "worker",
          at: 1_700_000_000_000,
        },
      },
    });
    expect((await store.get(card.id))?.metadata?.review?.verdicts).toBeUndefined();

    await expectRejected(
      store.move(card.id, "done", undefined, { ownerId: "reviewer-a" }),
      "recorded 1 (reviewer-a)",
    );
    // The same reviewer cannot supply the missing verdict for themselves.
    await expectRejected(
      store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-a" }),
      "already accepted this review attempt",
    );
    expect((await store.get(card.id))?.metadata?.review?.verdicts).toBeUndefined();

    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-b" });
    const done = await store.move(card.id, "done", undefined, { ownerId: "reviewer-b" });
    expect(done.status).toBe("done");
  });

  it("lets one rejection be decisive even after two accepts", async () => {
    const store = createStore();
    const card = await completedCard(store, {
      title: "Rejected after two accepts",
      labels: ["code"],
    });

    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-a" });
    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-b" });
    await store.claim(card.id, { ownerId: "rejecter", token: "token-reject" });
    const rejected = await store.move(
      card.id,
      "running",
      undefined,
      { ownerId: "rejecter", token: "token-reject" },
      { reason: "Found a defect the acceptances missed." },
    );

    // One rejection wins: the card is back in flight, and the accepts are void with the attempt.
    expect(rejected.status).toBe("running");
    expect(rejected.metadata?.review?.status).toBe("rejected");
    expect(rejected.metadata?.review?.verdicts).toBeUndefined();
    expect(rejected.metadata?.acceptance).toBeUndefined();
  });

  it("does not let verdicts from two attempts combine (move-only rework)", async () => {
    const store = createStore();
    // The exact trace: enter review by move, never by complete.
    const card = await completedCard(store, { title: "Move-only rework", labels: ["code"] });
    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-a" });

    await store.claim(card.id, { ownerId: "worker", token: "token-move" });
    await store.move(
      card.id,
      "running",
      undefined,
      { ownerId: "worker", token: "token-move" },
      { reason: "Rework after findings." },
    );
    const back = await store.move(
      card.id,
      "review",
      undefined,
      { ownerId: "worker", token: "token-move" },
      { reason: "Rework delivered." },
    );
    expect(back.metadata?.review?.verdicts).toBeUndefined();

    // reviewer-a from the previous attempt must not count now, and reviewer-b alone is not two.
    await store.accept(card.id, { artifact: TREE }, { ownerId: "reviewer-b" });
    await expectRejected(
      store.move(card.id, "done", undefined, { ownerId: "reviewer-b" }),
      "recorded 1 (reviewer-b)",
    );
  });

  it("drops stale verdicts when a card enters review without leaving it first", async () => {
    const store = createStore();
    // A card that never left review still has to start its attempt clean: the entering guard is
    // the only thing that can drop verdicts here, because the leaving branch never ran.
    const card = await createCard(store, "Carried-in verdicts", {
      status: "todo",
      labels: ["code"],
      metadata: {
        review: {
          required: true,
          status: "pending",
          completedBy: "worker",
          at: 1_700_000_000_000,
          verdicts: [{ reviewer: "reviewer-a", at: 1_700_000_000_000, artifact: TREE }],
        },
      },
    });

    const moved = await store.move(card.id, "review", undefined, { ownerId: "mover" });
    expect(moved.metadata?.review?.verdicts).toBeUndefined();
  });

  it("leaves ordinary cards on the single-verdict path", async () => {
    const store = createStore();
    const card = await completedCard(store, { title: "Ordinary card" });

    await store.accept(card.id, {}, { ownerId: "reviewer-a" });
    const done = await store.move(card.id, "done", undefined, { ownerId: "reviewer-a" });

    expect(done.status).toBe("done");
    expect(done.metadata?.review?.verdicts).toHaveLength(1);
  });
});
