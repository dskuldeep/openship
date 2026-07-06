import { describe, expect, it, vi } from "vitest";

// The Postgres advisory-lock layer is exercised by the deploy smoke; here we mock
// it to a passthrough so the test focuses on the in-process keyed-mutex behaviour.
vi.mock("@repo/db", () => ({
  withAdvisoryLock: <T>(_scopeKey: string, fn: () => Promise<T>) => fn(),
}));

import { createProvisionLock } from "../../src/lib/provision-lock";

describe("createProvisionLock", () => {
  it("serializes concurrent run() for the same scope (no overlap)", async () => {
    const lock = createProvisionLock("scope-a");
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;

    const task = (id: string, delayMs: number) =>
      lock.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start-${id}`);
        await new Promise((r) => setTimeout(r, delayMs));
        order.push(`end-${id}`);
        active -= 1;
      });

    await Promise.all([task("1", 20), task("2", 5), task("3", 10)]);

    expect(maxActive).toBe(1); // never ran two at once
    // Each task's start is immediately followed by its own end — no interleaving,
    // and they run in the order they were queued.
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
  });

  it("serializes across separate lock instances that share a scope", async () => {
    // Two deploys build their own createProvisionLock() for the same server —
    // they must still serialize (the gate is keyed by scope, not by instance).
    const a = createProvisionLock("scope-shared");
    const b = createProvisionLock("scope-shared");
    let active = 0;
    let maxActive = 0;
    const body = () => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
    };

    await Promise.all([a.run(body()), b.run(body())]);

    expect(maxActive).toBe(1);
  });

  it("runs different scopes concurrently", async () => {
    const a = createProvisionLock("scope-x");
    const b = createProvisionLock("scope-y");
    let aActive = false;
    let bActive = false;
    let overlapped = false;

    await Promise.all([
      a.run(async () => {
        aActive = true;
        await new Promise((r) => setTimeout(r, 20));
        if (bActive) overlapped = true;
        aActive = false;
      }),
      b.run(async () => {
        bActive = true;
        await new Promise((r) => setTimeout(r, 20));
        if (aActive) overlapped = true;
        bActive = false;
      }),
    ]);

    expect(overlapped).toBe(true); // independent scopes did not block each other
  });

  it("releases the lock when fn throws, so the next caller proceeds", async () => {
    const lock = createProvisionLock("scope-err");
    await expect(
      lock.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const result = await lock.run(async () => "ok");
    expect(result).toBe("ok");
  });
});
