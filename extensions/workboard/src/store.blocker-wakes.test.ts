// Blocker-aware wakes: one job per blocked card, retired by every path out of blocked.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { fakeClock } from "./store-family.test-support.js";
import { cancelWorkboardWake } from "./store-wake-support.js";
import type { WorkboardStore } from "./store.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";
import { buildWorkboardWakeJob, createWorkboardWakeService } from "./wake-scheduler.js";

const warn = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => ({
      ...actual.createSubsystemLogger(...args),
      warn,
    }),
  };
});

const OWNER = "tali";
const LANE = "1400000000000000001";
const MISSING_FILE = "/tmp/workboard-fixtures/missing-report.pdf";
const bindings = [
  { agentId: "main", match: { channel: "telegram" } },
  { agentId: OWNER, match: { channel: "discord", peer: { kind: "channel", id: LANE } } },
];
const blockedOn = { kind: "artifact", value: MISSING_FILE };

type StoredJob = ReturnType<typeof buildWorkboardWakeJob> & {
  id: string;
  state?: { runningAtMs?: number };
};

let stopService: (() => void) | undefined;
afterEach(() => {
  stopService?.();
  stopService = undefined;
  warn.mockClear();
});

function setup(config: { bindings?: typeof bindings } = { bindings }) {
  const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
  const jobs = new Map<string, StoredJob>();
  let nextJob = 0;
  const cron = {
    add: vi.fn(async (input: Omit<StoredJob, "id">) => {
      const job = { ...input, id: `wake-job-${++nextJob}` };
      jobs.set(job.id, job);
      return job;
    }),
    remove: vi.fn(async (id: string) => ({ removed: jobs.delete(id) })),
    list: vi.fn(async () => [...jobs.values()]),
    update: vi.fn(async (id: string, patch: Omit<StoredJob, "id">) => {
      const job = jobs.get(id);
      if (!job) {
        throw new Error(`unknown cron job id: ${id}`);
      }
      jobs.set(id, { ...job, ...patch });
      return jobs.get(id);
    }),
    removeStaleJobFamily: vi.fn(),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const service = createWorkboardWakeService({ currentConfig: () => config });
  service.start({ logger, getCron: () => cron } as never);
  stopService = service.stop;
  store.wakeScheduler = service.scheduler;
  return { store, cron, jobs, logger, scheduler: service.scheduler };
}

async function blockedWithWake(store: WorkboardStore) {
  const card = await store.create({
    title: "Publish the report",
    agentId: OWNER,
    status: "running",
  });
  const scope = { ownerId: OWNER, token: "token-wake" };
  await store.claim(card.id, scope);
  return await store.block(card.id, { ...scope, reason: "waiting", blockedOn, wakeInMinutes: 30 });
}

function expectNoWakeMetadata(card: { metadata?: Record<string, unknown> } | undefined) {
  expect(card?.metadata?.blockedOn).toBeUndefined();
  expect(card?.metadata?.wakeAt).toBeUndefined();
  expect(card?.metadata?.wakeJobId).toBeUndefined();
}

describe("Workboard blocker wakes", () => {
  it("arms one wake naming the missing-file blocker on the owner's lane, and resolving removes it", async () => {
    const { store, cron, jobs } = setup();
    const before = Date.now();

    const card = await blockedWithWake(store);

    expect(cron.add).toHaveBeenCalledTimes(1);
    expect([...jobs.keys()]).toEqual([card.metadata?.wakeJobId]);
    const job = jobs.get(card.metadata!.wakeJobId!)!;
    expect(job.payload.kind).toBe("agentTurn");
    expect(job.payload.message).toContain(card.id);
    expect(job.payload.message).toContain("Publish the report");
    expect(job.payload.message).toContain(MISSING_FILE);
    expect(job.payload.message).toContain("blocked and awaiting resolution");
    expect(job.delivery).toEqual({
      mode: "announce",
      channel: "discord",
      to: `channel:${LANE}`,
      threadId: LANE,
    });
    expect(job.sessionTarget).toBe(`session:agent:${OWNER}:main`);
    expect(job.schedule.kind).toBe("at");
    expect(Date.parse(job.schedule.at)).toBe(card.metadata?.wakeAt);
    expect(card.metadata?.wakeAt).toBeGreaterThanOrEqual(before + 30 * 60_000);

    // Read back through SQLite, not the returned object.
    expect((await store.get(card.id))?.metadata).toMatchObject({
      blockedOn,
      wakeAt: card.metadata?.wakeAt,
      wakeJobId: job.id,
    });

    expectNoWakeMetadata(await store.unblock(card.id));
    expect(cron.remove).toHaveBeenCalledWith(job.id);
    expect(jobs.size).toBe(0);
    expectNoWakeMetadata(await store.get(card.id));
  });

  it("moves the wake in place on a second block, keeping the same job", async () => {
    const { store, cron, jobs } = setup();
    const card = await blockedWithWake(store);
    const jobId = card.metadata!.wakeJobId!;
    const firstAt = jobs.get(jobId)!.schedule.at;
    const newFile = "/tmp/workboard-fixtures/other.pdf";

    const again = await store.block(
      card.id,
      { wakeInMinutes: 5, blockedOn: { kind: "artifact", value: newFile } },
      null,
    );

    expect(cron.update).toHaveBeenCalledTimes(1);
    expect(cron.add).toHaveBeenCalledTimes(1);
    expect(cron.remove).not.toHaveBeenCalled();
    expect([...jobs.keys()]).toEqual([jobId]);
    expect(again.metadata?.wakeJobId).toBe(jobId);
    const moved = jobs.get(jobId)!;
    expect(moved.schedule.at).not.toBe(firstAt);
    expect(Date.parse(moved.schedule.at)).toBe(again.metadata?.wakeAt);
    expect(again.metadata?.wakeInMinutes).toBe(5);
    expect(moved.payload.message).toContain(newFile);
    expect(moved.delivery).toMatchObject({ channel: "discord", threadId: LANE });
  });

  it("falls back to cancel and arm when the update fails", async () => {
    const { store, cron, jobs } = setup();
    const card = await blockedWithWake(store);
    const first = card.metadata!.wakeJobId!;
    cron.update.mockRejectedValueOnce(new Error("update refused"));

    const again = await store.block(card.id, { wakeInMinutes: 5 }, null);

    expect(jobs.has(first)).toBe(false);
    expect(again.metadata?.wakeJobId).not.toBe(first);
    expect([...jobs.keys()]).toEqual([again.metadata?.wakeJobId]);
    expect(cron.remove.mock.invocationCallOrder[0]).toBeLessThan(
      cron.add.mock.invocationCallOrder[1]!,
    );
  });

  it("never stacks a second wake when neither update nor remove works", async () => {
    const { store, cron, jobs } = setup();
    const card = await blockedWithWake(store);
    const first = card.metadata!.wakeJobId!;
    cron.update.mockRejectedValueOnce(new Error("update refused"));
    cron.remove.mockRejectedValueOnce(new Error("remove refused"));

    const again = await store.block(card.id, { wakeInMinutes: 5 }, null);

    expect(cron.add).toHaveBeenCalledTimes(1);
    expect([...jobs.keys()]).toEqual([first]);
    expect(again.status).toBe("blocked");
    expect(again.metadata).toMatchObject({
      wakeJobId: first,
      wakeAt: card.metadata?.wakeAt,
      wakeInMinutes: 30,
    });
    expect(again.metadata?.comments?.at(-1)?.body).toContain("Wake not replaced");
    expect((await store.get(card.id))?.metadata?.wakeJobId).toBe(first);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`(job ${first})`));
  });

  it("keeps the old wake when this process has no scheduler", async () => {
    const { store, cron, jobs } = setup();
    const card = await blockedWithWake(store);
    store.wakeScheduler = undefined;

    const again = await store.block(card.id, { wakeInMinutes: 5 }, null);

    expect(cron.add).toHaveBeenCalledTimes(1);
    expect(jobs.size).toBe(1);
    expect(again.metadata?.wakeJobId).toBe(card.metadata?.wakeJobId);
    expect(again.metadata?.comments?.at(-1)?.body).toContain("Wake not replaced");
  });

  it("keeps the old wake when a re-block has no owner to target", async () => {
    const { store, cron } = setup();
    const card = await store.create({ title: "No agent", status: "running" });
    const scope = { ownerId: OWNER, token: "token-ownerless" };
    await store.claim(card.id, scope);
    const blocked = await store.block(card.id, { ...scope, wakeInMinutes: 30 });

    const again = await store.block(card.id, { wakeInMinutes: 5 }, null);

    expect(cron.add).toHaveBeenCalledTimes(1);
    expect(cron.update).not.toHaveBeenCalled();
    expect(again.metadata?.wakeJobId).toBe(blocked.metadata?.wakeJobId);
    expect(again.metadata?.comments?.at(-1)?.body).toContain("Wake not replaced");
  });

  it("does not remove an updated job when the card write loses", async () => {
    const { store, jobs } = setup();
    const card = await blockedWithWake(store);
    vi.spyOn(
      store as never as { updateCard: () => Promise<never> },
      "updateCard",
    ).mockRejectedValue(new Error("write lost"));

    await expect(store.block(card.id, { wakeInMinutes: 5 }, null)).rejects.toThrow("write lost");

    expect([...jobs.keys()]).toEqual([card.metadata?.wakeJobId]);
  });

  it("reports whether a cancel removed the job", async () => {
    const { store, cron, scheduler } = setup();
    const card = await blockedWithWake(store);
    const jobId = card.metadata!.wakeJobId!;

    cron.remove.mockRejectedValueOnce(new Error("remove refused"));
    expect(await cancelWorkboardWake(scheduler, card.id, jobId)).toBe(false);
    expect(warn.mock.calls.at(-1)?.[0]).toContain(`card ${card.id} (job ${jobId})`);
    expect(await cancelWorkboardWake(scheduler, card.id, jobId)).toBe(true);
    expect(await cancelWorkboardWake(undefined, card.id, jobId)).toBe(false);
  });

  it("keeps the armed wake on a second block that requests none", async () => {
    const { store, cron, jobs } = setup();
    const card = await blockedWithWake(store);

    const again = await store.block(card.id, { reason: "still waiting" }, null);

    expect(cron.add).toHaveBeenCalledTimes(1);
    expect(cron.remove).not.toHaveBeenCalled();
    expect(again.metadata?.wakeJobId).toBe(card.metadata?.wakeJobId);
    expect(again.metadata?.wakeAt).toBe(card.metadata?.wakeAt);
    expect(jobs.size).toBe(1);
  });

  it("treats a double cancel and an unknown job as no-ops", async () => {
    const { store, cron, jobs, scheduler } = setup();
    const card = await blockedWithWake(store);
    const jobId = card.metadata!.wakeJobId!;

    await scheduler.cancel(jobId);
    await scheduler.cancel(jobId);
    await scheduler.cancel("never-existed");

    expect(jobs.size).toBe(0);
    expect(cron.remove).toHaveBeenCalledTimes(1);
  });

  it.each<[string, (store: WorkboardStore, id: string) => Promise<unknown>]>([
    ["unblock", (store, id) => store.unblock(id)],
    ["claim", (store, id) => store.claim(id, { ownerId: "garrus" })],
    ["move", (store, id) => store.move(id, "todo", undefined)],
    ["reassign", (store, id) => store.reassign(id, { agentId: "garrus" }, null)],
    ["complete", (store, id) => store.complete(id, { closureReason: "delivered" }, null)],
    ["archive", (store, id) => store.archive(id, true)],
  ])("%s retires the wake", async (_path, resolve) => {
    const { store, jobs } = setup();
    const card = await blockedWithWake(store);
    expect(jobs.size).toBe(1);

    await resolve(store, card.id);

    expect(jobs.size).toBe(0);
    expectNoWakeMetadata(await store.get(card.id));
  });

  it("delete retires the wake", async () => {
    const { store, jobs } = setup();
    const card = await blockedWithWake(store);

    await store.delete(card.id);

    expect(jobs.size).toBe(0);
  });

  // Handoff needs a claim and accept needs review; reaching either has already retired the wake.
  it("leaves no wake behind on the way to handoff", async () => {
    const { store, jobs } = setup();
    const card = await blockedWithWake(store);
    const scope = { ownerId: OWNER, token: "token-again" };

    await store.claim(card.id, scope);
    expect(jobs.size).toBe(0);
    const { source } = await store.handoff(card.id, { ...scope, toAgent: "garrus" });

    expectNoWakeMetadata(source);
  });

  it("refuses to accept a blocked card and retires the wake on the way to accept", async () => {
    const { store, jobs } = setup();
    const card = await blockedWithWake(store);

    await expect(store.accept(card.id, {}, { ownerId: "garrus" })).rejects.toThrow(
      "expected review",
    );
    expect(jobs.size).toBe(1);

    await store.complete(card.id, { closureReason: "delivered" }, { ownerId: OWNER });
    expect(jobs.size).toBe(0);
    const accepted = await store.accept(card.id, {}, { ownerId: "garrus" });
    expectNoWakeMetadata(accepted);
  });

  it("does not fail the card write when the scheduler refuses the removal", async () => {
    const { store, cron } = setup();
    const card = await blockedWithWake(store);
    cron.remove.mockRejectedValueOnce(new Error("scheduler stopping"));

    const unblocked = await store.unblock(card.id);

    expect(unblocked.status).toBe("todo");
    expectNoWakeMetadata(unblocked);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(
      `workboard wake for card ${card.id} (job ${card.metadata?.wakeJobId}) was not cancelled`,
    );
    expect(warn.mock.calls[0]?.[0]).toContain("scheduler stopping");
  });

  it("re-arms a consumed wake at the recorded window when a block requests none", async () => {
    const { store, cron, jobs } = setup();
    const card = await blockedWithWake(store);
    const consumed = card.metadata!.wakeJobId!;
    jobs.delete(consumed);
    const before = Date.now();

    const again = await store.block(card.id, { reason: "still waiting" }, null);

    expect(cron.add).toHaveBeenCalledTimes(2);
    const rearmed = again.metadata!.wakeJobId!;
    expect(rearmed).not.toBe(consumed);
    expect([...jobs.keys()]).toEqual([rearmed]);
    expect(jobs.get(rearmed)!.payload.message).toContain(MISSING_FILE);
    expect(again.metadata?.wakeInMinutes).toBe(30);
    expect(again.metadata?.wakeAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(again.metadata?.wakeAt).toBeLessThan(card.metadata!.wakeAt! + 60_000);
    expect((await store.get(card.id))?.metadata?.wakeJobId).toBe(rearmed);
  });

  it("re-arms at 60 minutes when a consumed wake recorded no interval", async () => {
    const { store, jobs } = setup();
    const card = await blockedWithWake(store);
    jobs.delete(card.metadata!.wakeJobId!);
    const { wakeInMinutes: _dropped, ...metadata } = card.metadata!;
    await store["store"].register(card.id, { version: 1, card: { ...card, metadata } });
    const before = Date.now();

    const again = await store.block(card.id, {}, null);

    expect(again.metadata?.wakeInMinutes).toBe(60);
    expect(again.metadata?.wakeAt).toBeGreaterThanOrEqual(before + 60 * 60_000);
    expect(jobs.size).toBe(1);
  });

  it("re-enables a stored job that can no longer fire instead of arming another", async () => {
    const { store, cron, jobs } = setup();
    const card = await blockedWithWake(store);
    const jobId = card.metadata!.wakeJobId!;
    jobs.get(jobId)!.enabled = false;

    const again = await store.block(card.id, {}, null);

    expect(cron.add).toHaveBeenCalledTimes(1);
    expect(again.metadata?.wakeJobId).toBe(jobId);
    expect(jobs.get(jobId)!.enabled).toBe(true);
  });

  it("keeps the stored wake when the scheduler cannot say whether it is live", async () => {
    const { store, cron } = setup();
    const card = await blockedWithWake(store);
    cron.list.mockRejectedValueOnce(new Error("scheduler stopping"));

    const again = await store.block(card.id, {}, null);

    expect(cron.add).toHaveBeenCalledTimes(1);
    expect(again.metadata?.wakeJobId).toBe(card.metadata?.wakeJobId);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(card.id));
  });

  it("leaves a running job to finish instead of cancelling the agent it woke", async () => {
    const { store, cron, jobs } = setup();
    const card = await blockedWithWake(store);
    jobs.get(card.metadata!.wakeJobId!)!.state = { runningAtMs: Date.now() };

    expectNoWakeMetadata(await store.unblock(card.id));

    expect(cron.remove).not.toHaveBeenCalled();
  });

  it("still arms a session-only wake when no lane is bound", async () => {
    const { store, jobs, logger } = setup({ bindings: [] });

    const card = await blockedWithWake(store);

    const job = jobs.get(card.metadata!.wakeJobId!)!;
    expect(job.sessionTarget).toBe(`session:agent:${OWNER}:main`);
    expect(job.delivery).toEqual({ mode: "none" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no Discord lane"));
  });

  it("keeps the block and says so when the scheduler cannot arm", async () => {
    const { store, cron } = setup();
    cron.add.mockRejectedValueOnce(new Error("scheduler offline"));

    const card = await blockedWithWake(store);

    expect(card.status).toBe("blocked");
    expect(card.metadata?.blockedOn).toEqual(blockedOn);
    expect(card.metadata?.wakeJobId).toBeUndefined();
    expect(card.metadata?.comments?.at(-1)?.body).toContain(
      "Wake not scheduled: scheduler offline",
    );
  });

  it("removes the new job when the card write loses", async () => {
    const { store, jobs } = setup();
    const card = await store.create({ title: "Conflict", agentId: OWNER });
    const conflict = new Error("write lost");
    vi.spyOn(
      store as never as { updateCard: () => Promise<never> },
      "updateCard",
    ).mockRejectedValue(conflict);

    await expect(store.block(card.id, { wakeInMinutes: 5 }, null)).rejects.toThrow(conflict);

    expect(jobs.size).toBe(0);
  });

  it("schedules through the port without process timers", async () => {
    const { store, cron } = setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    try {
      await blockedWithWake(store);
      expect(cron.add).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid input before touching the scheduler", async () => {
    const { store, cron } = setup();
    const card = await store.create({ title: "Invalid", agentId: OWNER });

    for (const wakeInMinutes of [0, 1.5, "5"]) {
      await expect(store.block(card.id, { wakeInMinutes }, null)).rejects.toThrow("wakeInMinutes");
    }
    await expect(
      store.block(card.id, { blockedOn: { kind: "weather", value: "rain" } }, null),
    ).rejects.toThrow("blockedOn");
    expect(cron.add).not.toHaveBeenCalled();
  });

  it("does not let client metadata point a card at someone else's job", async () => {
    const { store, cron } = setup();
    const card = await store.create({ title: "Spoof", status: "blocked" });

    const updated = await store.update(card.id, { metadata: { wakeJobId: "operators-job" } });
    await store.unblock(card.id);

    expect(updated.metadata?.wakeJobId).toBeUndefined();
    expect(cron.remove).not.toHaveBeenCalled();
  });
});

describe("Workboard held and overdue views", () => {
  async function seedViews(store: WorkboardStore) {
    const held = await blockedWithWake(store);
    const blockedOnly = await store.create({ title: "Blocked without wake", status: "blocked" });
    const fresh = await store.create({ title: "Fresh claim", status: "running" });
    await store.claim(fresh.id, { ownerId: "fresh-owner", ttlSeconds: 3600 });
    const expired = await store.create({ title: "Expired claim", status: "running" });
    await store.claim(expired.id, { ownerId: "expired-owner", ttlSeconds: 60 });
    return { held, blockedOnly, fresh, expired };
  }

  it("filters workboard_list", async () => {
    const { store } = setup();
    using clock = fakeClock();
    const start = Date.now();
    clock.set(start);
    const { held, expired } = await seedViews(store);
    clock.set(start + 120_000);
    const list = createWorkboardTools({ store }).find((tool) => tool.name === "workboard_list")!;
    const ids = async (view: string) =>
      (
        (await list.execute("call", { view })).details as { cards: Array<{ id: string }> }
      ).cards.map((card) => card.id);

    expect(await ids("held")).toEqual([held.id]);
    expect(await ids("overdue")).toEqual([expired.id]);
  });

  it("filters workboard.cards.list and never answers unchanged for a view", async () => {
    const { store } = setup();
    using clock = fakeClock();
    const start = Date.now();
    clock.set(start);
    const { held, expired } = await seedViews(store);
    clock.set(start + 120_000);
    const { methods, registerGatewayMethod } = createGatewayMethodCapture();
    registerWorkboardGatewayMethods({
      api: { registerGatewayMethod, runtime: {} } as unknown as OpenClawPluginApi,
      store,
    });
    const invoke = async (params: Record<string, unknown>) => {
      const respond = vi.fn();
      await methods.get("workboard.cards.list")!.handler({ params, respond } as never);
      return respond.mock.calls[0] as [boolean, { cards: Array<{ id: string }>; revision: object }];
    };

    const [heldOk, heldResult] = await invoke({ view: "held" });
    expect(heldOk).toBe(true);
    expect(heldResult.cards.map((card) => card.id)).toEqual([held.id]);
    const [, overdue] = await invoke({ view: "overdue", sinceRevision: heldResult.revision });
    expect(overdue.cards.map((card) => card.id)).toEqual([expired.id]);
    expect((await invoke({ view: "nonsense" }))[0]).toBe(false);
  });
});
