import { describe, expect, it, vi } from "vitest";
import { ReadBatch } from "../src/utils/ReadBatch";
import { CommitBatch } from "../src/utils/CommitBatch";
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("fresh shared reads", () => {
  it("shares unsent reads but never reuses an in-flight or completed result", async () => {
    const batch = new ReadBatch<string>(),
      wait = gate();
    const read = vi.fn(async () => {
      await wait.promise;
      return "before mutation";
    });
    const one = batch.run("file", read),
      two = batch.run("file", read);
    expect(one).toBe(two);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const fresh = vi.fn(async () => "after mutation");
    expect(await batch.run("file", fresh)).toBe("after mutation");
    wait.release();
    expect(await one).toBe("before mutation");
    expect(await two).toBe("before mutation");
    expect(await batch.run("file", fresh)).toBe("after mutation");
    expect(fresh).toHaveBeenCalledTimes(2);
  });
  it("propagates a shared failure and allows a fresh read afterward", async () => {
    const batch = new ReadBatch<string>();
    const read = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await Promise.allSettled([
      batch.run("file", read),
      batch.run("file", read),
    ]);
    expect(read).toHaveBeenCalledOnce();
    expect(result.every((item) => item.status === "rejected")).toBe(true);
    expect(await batch.run("file", async () => "fresh")).toBe("fresh");
  });
});

describe("durable commit batching", () => {
  it("groups ready mutations and resolves neither caller before their shared save finishes", async () => {
    const wait = gate(),
      applied: number[] = [],
      commit = vi.fn(async (mutations: (() => void)[]) => {
        for (const mutate of mutations) mutate();
        await wait.promise;
      });
    const batch = new CommitBatch(commit);
    let resolved = 0;
    const first = batch
      .run(() => applied.push(1))
      .then(() => {
        resolved++;
      });
    const second = batch
      .run(() => applied.push(2))
      .then(() => {
        resolved++;
      });
    await vi.waitFor(() => expect(applied).toEqual([1, 2]));
    expect(commit).toHaveBeenCalledOnce();
    expect(resolved).toBe(0);
    wait.release();
    await Promise.all([first, second]);
    expect(resolved).toBe(2);
  });
  it("serializes later mutations until the previous durable transaction is done", async () => {
    const wait = gate(),
      applied: number[] = [];
    let saves = 0;
    const batch = new CommitBatch(async (mutations) => {
      for (const mutate of mutations) mutate();
      if (++saves === 1) await wait.promise;
    });
    const first = batch.run(() => applied.push(1));
    await vi.waitFor(() => expect(applied).toEqual([1]));
    const second = batch.run(() => applied.push(2));
    await Promise.resolve();
    expect(applied).toEqual([1]);
    wait.release();
    await Promise.all([first, second]);
    expect(applied).toEqual([1, 2]);
  });
  it("rejects every member of a failed transaction", async () => {
    const batch = new CommitBatch(async (mutations) => {
      for (const mutate of mutations) mutate();
      throw new Error("disk full");
    });
    const results = await Promise.allSettled([
      batch.run(() => {}),
      batch.run(() => {}),
    ]);
    expect(
      results.every(
        (item) =>
          item.status === "rejected" &&
          (item.reason as Error).message === "disk full",
      ),
    ).toBe(true);
  });
});
