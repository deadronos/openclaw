// Workboard card handoff: the source closes as handed_off_to and a linked ready card moves on.
import { describe, expect, it } from "vitest";
import { createCard, expectRejected } from "./store-family.test-support.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const createStore = () => createWorkboardSqliteTestStore({ createStores: createKernelStores });

const workerScope = { ownerId: "worker", token: "token-handoff" };

async function claimedCard(
  store: ReturnType<typeof createStore>,
  title: string,
  input: Record<string, unknown> = {},
) {
  const card = await createCard(store, title, { status: "running", ...input });
  await store.claim(card.id, workerScope);
  return card;
}

function linkedIds(card: {
  metadata?: { links?: Array<{ type: string; targetCardId?: string }> };
}) {
  return (card.metadata?.links ?? [])
    .filter((link) => link.type === "parent" || link.type === "child")
    .map((link) => `${link.type}:${link.targetCardId}`);
}

describe("Workboard card handoff", () => {
  it("closes the source as handed off and links a ready card for the receiving agent", async () => {
    const store = createStore();
    const card = await claimedCard(store, "Ship the report", {
      notes: "Draft is ready.",
    });

    const { source, destination } = await store.handoff(card.id, {
      ...workerScope,
      toAgent: "reviewer",
      note: "needs your sign-off",
    });

    expect(source).toMatchObject({
      status: "done",
      completedAt: expect.any(Number),
      metadata: {
        closureReason: "handed_off_to",
        review: {
          required: true,
          status: "skipped",
          reason: "handed off by worker to reviewer: needs your sign-off",
          actor: "worker",
        },
      },
    });
    expect(source.metadata?.claim).toBeUndefined();
    expect(source.events?.filter((event) => event.kind === "handoff")).toEqual([
      expect.objectContaining({ kind: "handoff", fromStatus: "running", toStatus: "done" }),
    ]);

    expect(destination).toMatchObject({
      title: "Ship the report",
      agentId: "reviewer",
      status: "ready",
    });
    expect(destination.notes).toBe(
      "Draft is ready.\n\nHanded off to reviewer: needs your sign-off",
    );
    expect(linkedIds(destination)).toEqual([`parent:${card.id}`]);
    expect(linkedIds(source)).toEqual([`child:${destination.id}`]);
    // The receiving agent really can pick it up.
    const claimed = await store.claim(destination.id, {
      ownerId: "reviewer",
      token: "token-next",
    });
    expect(claimed.card.status).toBe("running");
  });

  it("gives the destination no claim, attempts, or proofs", async () => {
    const store = createStore();
    const card = await claimedCard(store, "Carry nothing over");
    await store.addProof(card.id, {
      ...workerScope,
      status: "passed",
      label: "manual check",
    });

    const { destination } = await store.handoff(card.id, {
      ...workerScope,
      toAgent: "reviewer",
    });

    expect(destination.metadata?.claim).toBeUndefined();
    expect(destination.metadata?.attempts).toBeUndefined();
    expect(destination.metadata?.proof).toBeUndefined();
    expect(destination.metadata?.review).toBeUndefined();
    expect(destination.metadata?.closureReason).toBeUndefined();
  });

  it("keeps review-mandatory labels on the destination so a handoff cannot launder review", async () => {
    const store = createStore();
    const card = await claimedCard(store, "Touch the code", {
      labels: ["code"],
    });

    const { destination } = await store.handoff(card.id, {
      ...workerScope,
      toAgent: "reviewer",
    });

    expect(destination.labels).toEqual(["code"]);
    await store.claim(destination.id, {
      ownerId: "reviewer",
      token: "token-next",
    });
    await expectRejected(
      store.complete(destination.id, {
        ownerId: "reviewer",
        token: "token-next",
        summary: "Done.",
        skipReview: true,
        skipReviewReason: "small task",
        closureReason: "delivered",
      }),
      /require review; skipReview is not allowed/,
    );
  });

  it("refuses a handoff without a claim that the caller owns", async () => {
    const store = createStore();
    const unclaimed = await createCard(store, "Nobody owns this", {
      status: "ready",
    });
    await expectRejected(
      store.handoff(unclaimed.id, { ...workerScope, toAgent: "reviewer" }),
      /card must be claimed before handoff/,
    );

    const card = await claimedCard(store, "Owned work");
    // complete()'s claim rule: either the owner or the claim token proves the caller owns it.
    await expectRejected(
      store.handoff(card.id, {
        ownerId: "someone-else",
        token: "not-the-token",
        toAgent: "reviewer",
      }),
      /card is claimed by worker/,
    );
    expect((await store.get(card.id))?.status).toBe("running");
  });

  it("refuses a handoff without a receiving agent", async () => {
    const store = createStore();
    const card = await claimedCard(store, "Needs a destination");

    await expectRejected(store.handoff(card.id, { ...workerScope, toAgent: "" }), /toAgent/);
    await expectRejected(store.handoff(card.id, workerScope), /toAgent/);
    expect(await store.list()).toHaveLength(1);
    expect((await store.get(card.id))?.status).toBe("running");
  });

  it("refuses to hand off already accepted work", async () => {
    const store = createStore();
    const card = await claimedCard(store, "Already reviewed");
    await store.complete(card.id, {
      ...workerScope,
      summary: "Ready.",
      closureReason: "delivered",
    });
    await store.accept(card.id, {}, { ownerId: "reviewer" });
    await store.claim(card.id, workerScope);

    await expectRejected(
      store.handoff(card.id, { ...workerScope, toAgent: "reviewer" }),
      /already accepted; close accepted work with the normal completion path/,
    );
    expect(await store.list()).toHaveLength(1);
  });

  it("still refuses a plain running to done move", async () => {
    const store = createStore();
    const card = await claimedCard(store, "No handoff shortcut");

    await expectRejected(
      store.move(card.id, "done", 0, workerScope),
      /must go through review before done/,
    );
    expect((await store.get(card.id))?.status).toBe("running");
  });

  it("leaves the source open when the link step fails", async () => {
    const store = createStore();
    const card = await claimedCard(store, "Link failure");
    // Force the middle phase to fail: the invariant under test is that the source is not closed
    // while the work is unlinked.
    const failing = store as unknown as {
      linkCardsDirect: (...args: unknown[]) => Promise<unknown>;
    };
    const original = failing.linkCardsDirect.bind(store);
    failing.linkCardsDirect = async () => {
      throw new Error("link exploded");
    };

    try {
      await expectRejected(
        store.handoff(card.id, { ...workerScope, toAgent: "reviewer" }),
        /link exploded/,
      );
    } finally {
      failing.linkCardsDirect = original;
    }

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("running");
    expect(stored?.metadata?.closureReason).toBeUndefined();
    expect(stored?.metadata?.review?.status).toBeUndefined();
  });

  it("names both agents in the recorded skip reason", async () => {
    const store = createStore();
    const card = await claimedCard(store, "Two identities");

    const { source } = await store.handoff(card.id, {
      ...workerScope,
      toAgent: "reviewer",
      note: "please review",
    });

    expect(source.metadata?.review?.reason).toBe("handed off by worker to reviewer: please review");
    expect(source.metadata?.review?.actor).toBe("worker");
  });
});
