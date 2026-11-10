import { describe, it, expect, vi } from "vitest";
import { SyncExecutor, massDeletion } from "../src/sync/SyncExecutor";
import { reconcile } from "../src/sync/ReconciliationEngine";
import { Backend, baseline, bytes, memoryStore } from "./helpers";
import type {
  Action,
  ByteProgress,
  Review,
  TransferProgress,
} from "../src/sync/types";
async function setup(
  l: Record<string, string>,
  r: Record<string, string>,
  withBaseline = false,
) {
  const local = new Backend(l),
    remote = new Backend(r, true),
    store = memoryStore();
  if (withBaseline) {
    store.state.baselines.ctx = { "a.pdf": baseline() };
  }
  const review: Review = {
    local: await local.scan(),
    remote: await remote.scan(),
    context: "ctx",
    changes: [],
  };
  review.changes = reconcile(
    review.local,
    review.remote,
    store.state.baselines.ctx ?? {},
  );
  const executor = new SyncExecutor(local, remote, store, () => "ctx");
  const apply = (action: Action, index = 0, mass = true) =>
    executor.apply(
      review,
      [{ change: review.changes[index]!, action }],
      true,
      mass,
    );
  return { local, remote, store, review, executor, apply };
}
describe("approved production execution", () => {
  it("rejects changed download bytes before writing local contents", async () => {
    const s = await setup({}, { "a.pdf": "original" });
    s.remote.read = async (_file, progress?: ByteProgress) => {
      progress?.(8, 8);
      return bytes("tampered");
    };
    const result = await s.executor.apply(
      s.review,
      [{ change: s.review.changes[0]!, action: "download" }],
      true,
      false,
      undefined,
      () => {},
    );
    expect(result[0]!.status).toBe("Needs Rescan");
    expect(s.local.calls).toEqual([]);
    expect(s.store.state.baselines.ctx).toBeUndefined();
  });
  it.each(["upload", "download"] as const)(
    "forwards %s bytes and verifies before reporting file success",
    async (action) => {
      const s = await setup(
        action === "upload" ? { "a.pdf": "original" } : {},
        action === "download" ? { "a.pdf": "original" } : {},
      );
      const transfers: TransferProgress[][] = [];
      const overall = vi.fn(() => {
        expect(s.store.state.operations.at(-1)!.status).toBe("Success");
        expect(Object.keys(s.store.state.baselines.ctx!)).toHaveLength(1);
      });
      if (action === "upload") {
        const original = s.remote.upload.bind(s.remote);
        s.remote.upload = async (
          path,
          data,
          expected,
          id,
          onProgress?: ByteProgress,
        ) => {
          onProgress?.(4, 8);
          await original(path, data, expected, id);
          onProgress?.(8, 8);
        };
      } else {
        const original = s.remote.read.bind(s.remote);
        s.remote.read = async (file, onProgress?: ByteProgress) => {
          onProgress?.(4, 8);
          const bytes = await original(file);
          onProgress?.(8, 8);
          return bytes;
        };
      }
      await s.executor.apply(
        s.review,
        [{ change: s.review.changes[0]!, action }],
        true,
        false,
        overall,
        (event) => transfers.push(event),
      );
      expect(
        transfers
          .flat()
          .map((event) => [event.phase, event.transferred, event.total]),
      ).toEqual([
        ["preparing", 0, 8],
        ["transferring", 4, 8],
        ["transferring", 8, 8],
        ["verifying", 8, 8],
      ]);
      expect(transfers.at(-1)).toEqual([]);
      expect(overall).toHaveBeenCalledOnce();
    },
  );

  it("a completed byte transfer with failed verification is still a failed file", async () => {
    const s = await setup({ "a.pdf": "original" }, {});
    s.remote.fail = "verify";
    const transfers: TransferProgress[][] = [];
    const overall = vi.fn();
    const result = await s.executor.apply(
      s.review,
      [{ change: s.review.changes[0]!, action: "upload" }],
      true,
      false,
      overall,
      (event) => transfers.push(event),
    );
    expect(result[0]!.status).toBe("Failed");
    expect(
      transfers
        .flat()
        .some(
          (event) => event?.phase === "verifying" && event.transferred === 8,
        ),
    ).toBe(true);
    expect(transfers.at(-1)).toEqual([]);
    expect(s.store.state.baselines.ctx).toBeUndefined();
  });
  it("uploads local addition, verifies reserved ID, records baseline and history", async () => {
    const s = await setup({ "a.pdf": "original" }, {});
    const result = await s.apply("upload");
    expect(result[0]!.status).toBe("Success");
    expect(s.remote.files["a.pdf"]!.id).toMatch(/^reserved/);
    expect(Object.values(s.store.state.baselines.ctx!)[0]!.hash).toEqual(
      s.local.files["a.pdf"]!.hashes,
    );
    expect(s.store.state.journal).toHaveLength(0);
    expect(s.store.state.operations).toHaveLength(1);
  });
  it("downloads remote addition with no prior-device deletion inference", async () => {
    const s = await setup({}, { "a.pdf": "original" });
    expect(s.review.changes[0]!.classification).toBe("Remote addition");
    await s.apply("download");
    expect(s.local.files["a.pdf"]!.hashes).toEqual(
      s.remote.files["a.pdf"]!.hashes,
    );
  });
  it("explicit accept establishes equal baseline without transfers", async () => {
    const s = await setup({ "a.pdf": "original" }, { "a.pdf": "original" });
    await s.apply("accept");
    expect(s.local.calls).toEqual([]);
    expect(s.remote.calls).toEqual([]);
    expect(Object.keys(s.store.state.baselines.ctx!)).toHaveLength(1);
  });
  it.each(["use-local", "use-remote"] as const)(
    "conflict %s overwrites only approved version with no copies",
    async (action) => {
      const s = await setup({ "a.pdf": "local" }, { "a.pdf": "remote" }, true);
      const result = await s.apply(action);
      expect(result[0]!.status).toBe("Success");
      expect(Object.keys(s.local.files)).toEqual(["a.pdf"]);
      expect(Object.keys(s.remote.files)).toEqual(["a.pdf"]);
      expect(s.local.files["a.pdf"]!.hashes).toEqual(
        s.remote.files["a.pdf"]!.hashes,
      );
    },
  );
  it("explicit skip leaves baseline and files unchanged and reappears", async () => {
    const s = await setup({ "a.pdf": "local" }, { "a.pdf": "original" }, true),
      before = JSON.stringify(s.store.state.baselines);
    await s.apply("skip");
    expect(JSON.stringify(s.store.state.baselines)).toBe(before);
    expect(
      reconcile(
        await s.local.scan(),
        await s.remote.scan(),
        s.store.state.baselines.ctx ?? {},
      )[0]!.category,
    ).toBe("modification");
    expect(s.store.state.operations[0]!.status).toBe("Skipped");
  });
  it("applies only one selected file and leaves other differences pending", async () => {
    const s = await setup({ a: "a", b: "b" }, {});
    await s.apply("upload");
    expect(Object.keys(s.remote.files)).toHaveLength(1);
    expect(
      reconcile(
        await s.local.scan(),
        await s.remote.scan(),
        s.store.state.baselines.ctx ?? {},
      ).filter((c) => c.category === "addition"),
    ).toHaveLength(1);
  });
  it.each([
    ["trash-remote", {}, { "a.pdf": "original" }],
    ["download", {}, { "a.pdf": "original" }],
    ["trash-local", { "a.pdf": "original" }, {}],
    ["upload", { "a.pdf": "original" }, {}],
  ] as const)("handles deletion/restore %s", async (action, l, r) => {
    const s = await setup(l, r, true),
      result = await s.apply(action);
    expect(result[0]!.status).toBe("Success");
    if (action.startsWith("trash"))
      expect(Object.values(s.store.state.baselines.ctx!)[0]!.hash).toBeNull();
    else
      expect(s.local.files["a.pdf"]!.hashes).toEqual(
        s.remote.files["a.pdf"]!.hashes,
      );
  });
  it("accepts both deleted into a durable tombstone", async () => {
    const s = await setup({}, {}, true);
    await s.apply("accept");
    expect(Object.values(s.store.state.baselines.ctx!)[0]!.hash).toBeNull();
  });
  it("local rename preserves remote ID without upload", async () => {
    const s = await setup(
        { "new.pdf": "original" },
        { "a.pdf": "original" },
        true,
      ),
      id = s.remote.files["a.pdf"]!.id;
    await s.apply("local-path");
    expect(s.remote.files["new.pdf"]!.id).toBe(id);
    expect(s.remote.calls).toEqual(["rename:a.pdf:new.pdf"]);
    expect(Object.values(s.store.state.baselines.ctx!)[0]!.path).toBe(
      "new.pdf",
    );
  });
  it("remote rename preserves local content without link-aware API", async () => {
    const s = await setup(
      { "a.pdf": "original" },
      { "new.pdf": "original" },
      true,
    );
    s.remote.files["new.pdf"]!.id = baseline().remoteId;
    s.review.remote = await s.remote.scan();
    s.review.changes = reconcile(
      s.review.local,
      s.review.remote,
      s.store.state.baselines.ctx!,
    );
    expect((await s.apply("remote-path"))[0]!.status).toBe("Success");
    expect(s.local.calls).toEqual(["rename:a.pdf:new.pdf"]);
  });
  it("path resolution does not advance content baseline when contents differ", async () => {
    const s = await setup(
      { "a.pdf": "local edit" },
      { "new.pdf": "remote edit" },
      true,
    );
    s.remote.files["new.pdf"]!.id = baseline().remoteId;
    s.review.remote = await s.remote.scan();
    s.review.changes = reconcile(
      s.review.local,
      s.review.remote,
      s.store.state.baselines.ctx!,
    );
    const before = JSON.stringify(s.store.state.baselines);
    expect((await s.apply("remote-path"))[0]!.status).toBe("Success");
    expect(JSON.stringify(s.store.state.baselines)).toBe(before);
    const next = reconcile(
      await s.local.scan(),
      await s.remote.scan(),
      s.store.state.baselines.ctx ?? {},
    );
    expect(next[0]!.classification).toBe("Both sides modified");
  });
  it("failed upload never advances confirmed baseline", async () => {
    const s = await setup({ "a.pdf": "local" }, { "a.pdf": "original" }, true),
      before = JSON.stringify(s.store.state.baselines);
    s.remote.fail = "upload";
    expect((await s.apply("use-local"))[0]!.status).toBe("Failed");
    expect(JSON.stringify(s.store.state.baselines)).toBe(before);
    expect(s.store.state.journal).toHaveLength(1);
  });
  it("failed post-transfer verification never confirms synchronized content", async () => {
    const s = await setup({ "a.pdf": "original" }, {});
    s.remote.fail = "verify";
    expect((await s.apply("upload"))[0]!.status).toBe("Failed");
    expect(s.store.state.baselines.ctx).toBeUndefined();
    expect(s.store.state.journal).toHaveLength(1);
  });
  it("stores observed times separately from confirmed timestamp", async () => {
    const s = await setup({ "a.pdf": "original" }, {});
    const scanAt = s.review.local.scannedAt;
    await s.apply("upload");
    const b = Object.values(s.store.state.baselines.ctx!)[0]!;
    expect(b.syncedAt).toBeGreaterThanOrEqual(scanAt);
    expect(b.local!.modifiedAt).toBeLessThan(b.syncedAt);
    expect(s.store.state.operations[0]!.finishedAt).toBeGreaterThanOrEqual(
      s.store.state.operations[0]!.at,
    );
  });
  it("history pruning leaves baselines and unresolved journal untouched", async () => {
    const s = await setup({ "a.pdf": "original" }, {});
    await s.apply("upload");
    const before = JSON.stringify(s.store.state.baselines);
    s.store.prune(Date.now() + 100 * 86400000);
    expect(s.store.state.operations).toHaveLength(0);
    expect(JSON.stringify(s.store.state.baselines)).toBe(before);
  });
  it("devices have independent baselines", async () => {
    const s = await setup({ "a.pdf": "original" }, {});
    await s.apply("upload");
    const other = memoryStore();
    expect(other.state.deviceId).not.toBe(s.store.state.deviceId);
    expect(
      reconcile(await new Backend().scan(), await s.remote.scan(), {})[0]!
        .classification,
    ).toBe("Remote addition");
  });
});
describe("stale preview and failures", () => {
  it.each(["local", "remote"] as const)(
    "%s edit after preview rejects overwrite",
    async (side) => {
      const s = await setup({ "a.pdf": "local" }, { "a.pdf": "remote" }, true);
      s[side].put("a.pdf", "after preview");
      expect((await s.apply("use-local"))[0]!.status).toBe("Needs Rescan");
      expect(s.remote.calls.some((c) => c.startsWith("upload"))).toBe(false);
    },
  );
  it("target removed after scan requires rescan", async () => {
    const s = await setup({ "a.pdf": "local" }, { "a.pdf": "remote" }, true);
    delete s.remote.files["a.pdf"];
    expect((await s.apply("use-local"))[0]!.status).toBe("Needs Rescan");
  });
  it("rename destination added after scan is rejected", async () => {
    const s = await setup(
      { "new.pdf": "original" },
      { "a.pdf": "original" },
      true,
    );
    s.remote.put("new.pdf", "unrelated");
    expect((await s.apply("local-path"))[0]!.status).toBe("Needs Rescan");
  });
  it("only stale operation is rejected; independent safe one completes", async () => {
    const s = await setup({ a: "a", b: "b" }, {});
    s.local.put("a", "changed");
    const result = await s.executor.apply(
      s.review,
      s.review.changes.map((change) => ({ change, action: "upload" })),
      true,
    );
    expect(result.map((o) => o.status)).toEqual(["Needs Rescan", "Success"]);
    expect(Object.keys(s.remote.files)).toEqual(["b"]);
  });
  it("rescan observes current state after stale rejection", async () => {
    const s = await setup({ "a.pdf": "local" }, { "a.pdf": "original" }, true);
    s.local.put("a.pdf", "after");
    await s.apply("use-local");
    const next = reconcile(
      await s.local.scan(),
      await s.remote.scan(),
      s.store.state.baselines.ctx ?? {},
    );
    expect(next[0]!.local!.hashes).toEqual(s.local.files["a.pdf"]!.hashes);
  });
  it("network failure in revalidation causes no mutation", async () => {
    const s = await setup({ "a.pdf": "local" }, { "a.pdf": "original" }, true);
    s.remote.fail = "scan";
    expect((await s.apply("use-local"))[0]!.status).toBe("Failed");
    expect(s.remote.calls).toEqual([]);
  });
  it("wrong remote folder identity rejects all affected operations", async () => {
    const s = await setup({ "a.pdf": "original" }, {});
    s.remote.identity = "wrong-folder";
    expect((await s.apply("upload"))[0]!.status).toBe("Needs Rescan");
  });
  it("changed account/context rejects batch", async () => {
    const s = await setup({ "a.pdf": "original" }, {});
    const ex = new SyncExecutor(
      s.local,
      s.remote,
      s.store,
      () => "wrong-account",
    );
    await expect(
      ex.apply(
        s.review,
        [{ change: s.review.changes[0]!, action: "upload" }],
        true,
      ),
    ).rejects.toThrow("context");
  });
  it("no execution without confirmation", async () => {
    const s = await setup({ "a.pdf": "original" }, {});
    await expect(
      s.executor.apply(
        s.review,
        [{ change: s.review.changes[0]!, action: "upload" }],
        false,
      ),
    ).rejects.toThrow("confirmation");
  });
  it("protects mass deletion above 25 percent", async () => {
    const s = await setup({}, { "a.pdf": "original" }, true);
    expect(
      massDeletion(
        [{ change: s.review.changes[0]!, action: "trash-remote" }],
        s.store.state.baselines.ctx!,
      ),
    ).toBe(true);
    await expect(s.apply("trash-remote", 0, false)).rejects.toThrow("25%");
    expect(s.remote.files["a.pdf"]).toBeDefined();
  });
  it("25 percent exactly needs only ordinary confirmation", async () => {
    const s = await setup({}, { "a.pdf": "original" }, true);
    const b = {
      ...s.store.state.baselines.ctx!,
      b: baseline("b"),
      c: baseline("c"),
      d: baseline("d"),
    };
    expect(
      massDeletion(
        [{ change: s.review.changes[0]!, action: "trash-remote" }],
        b,
      ),
    ).toBe(false);
    // Ignored baselines remain stored, but must not dilute the deletion guard.
    expect(
      massDeletion(
        [{ change: s.review.changes[0]!, action: "trash-remote" }],
        b,
        s.review,
      ),
    ).toBe(true);
  });
  it("cancels between operations, preserving verified completions and pending files", async () => {
    const s = await setup({ a: "a", b: "b" }, {});
    s.store.state.maxConcurrentTransfers = 1;
    const result = await s.executor.apply(
      s.review,
      s.review.changes.map((change) => ({ change, action: "upload" })),
      true,
      false,
      () => s.executor.cancel(),
    );
    expect(result.map((o) => o.status)).toEqual(["Success", "Cancelled"]);
    expect(Object.keys(s.remote.files)).toEqual(["a"]);
  });
  it("blocks duplicate Apply calls", async () => {
    const s = await setup({ a: "a" }, {});
    s.executor.busy = true;
    await expect(s.apply("upload")).rejects.toThrow("already");
  });
  it("blocks invalid action not offered by review", async () => {
    const s = await setup({ a: "a" }, {});
    await expect(s.apply("trash-remote")).rejects.toThrow("Invalid");
  });
  it("interrupted upload retry is a fresh review, not blind create", async () => {
    const s = await setup({ a: "a" }, {});
    s.remote.fail = "verify";
    await s.apply("upload");
    expect(s.store.state.journal[0]!.remoteId).toBeDefined();
    s.remote.fail = "";
    const next = reconcile(await s.local.scan(), await s.remote.scan(), {});
    expect(next[0]!.actions).toContain("use-local");
    expect(Object.keys(s.remote.files)).toHaveLength(1);
  });
});
describe("postconditions and persistence", () => {
  it("rejects local edits occurring during upload even if old remote upload succeeds", async () => {
    const s = await setup({ "a.pdf": "original" }, {});
    const upload = s.remote.upload.bind(s.remote);
    s.remote.upload = async (...args) => {
      await upload(...args);
      s.local.put("a.pdf", "new external edit");
    };
    expect((await s.apply("upload"))[0]!.status).toBe("Failed");
    expect(s.store.state.baselines.ctx).toBeUndefined();
  });
  it("journals before any content mutation and stops when persistence fails", async () => {
    const s = await setup({ a: "a", b: "b" }, {});
    s.store.save = async () => {
      throw new Error("disk full");
    };
    await expect(
      s.executor.apply(
        s.review,
        s.review.changes.map((change) => ({ change, action: "upload" })),
        true,
      ),
    ).rejects.toThrow("disk full");
    expect(s.remote.calls).toEqual([]);
    expect(s.store.state.baselines.ctx).toBeUndefined();
  });
  it("post-verification persistence failure rolls back in-memory baseline and retains unresolved journal", async () => {
    const s = await setup({ a: "a" }, {});
    let count = 0;
    const save = s.store.save.bind(s.store);
    s.store.save = async () => {
      if (++count >= 2) throw new Error("disk full");
      await save();
    };
    await expect(s.apply("upload")).rejects.toThrow("disk full");
    expect(s.store.state.baselines.ctx).toBeUndefined();
    expect(s.store.state.journal).toHaveLength(1);
  });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("concurrent transfers", () => {
  it("shares a limit across uploads/downloads, refills freed slots, and commits out of order", async () => {
    const s = await setup({ a: "a", c: "c" }, { b: "b", d: "d" });
    s.store.state.maxConcurrentTransfers = 2;
    const gates = new Map<string, ReturnType<typeof gate>>();
    const start = async (path: string) => {
      expect(s.store.state.journal.some((op) => op.path === path)).toBe(true);
      const wait = gate();
      gates.set(path, wait);
      await wait.promise;
    };
    const upload = s.remote.upload.bind(s.remote),
      read = s.remote.read.bind(s.remote);
    s.remote.upload = async (...args) => {
      await start(args[0]);
      await upload(...args);
    };
    s.remote.read = async (file) => {
      await start(typeof file === "string" ? file : file.path);
      return read(file);
    };
    const completed: number[] = [],
      progress: TransferProgress[][] = [];
    const task = s.executor.apply(
      s.review,
      s.review.changes.map((change) => ({
        change,
        action: change.local ? "upload" : "download",
      })),
      true,
      false,
      (_op, count) => completed.push(count),
      (items) => progress.push(items),
    );
    await vi.waitFor(() =>
      expect([...gates.keys()].sort()).toEqual(["a", "b"]),
    );
    // A settings change affects the next batch, never expands the running pool.
    s.store.state.maxConcurrentTransfers = 8;
    gates.get("b")!.release();
    await vi.waitFor(() => expect(gates.has("c")).toBe(true));
    expect(gates.has("d")).toBe(false);
    expect(completed).toEqual([1]);
    expect(s.store.state.operations[0]!.path).toBe("b");
    gates.get("c")!.release();
    await vi.waitFor(() => expect(gates.has("d")).toBe(true));
    gates.get("d")!.release();
    gates.get("a")!.release();
    const result = await task;
    expect(result.map((op) => op.path)).toEqual(["a", "b", "c", "d"]);
    expect(result.every((op) => op.status === "Success")).toBe(true);
    expect(completed).toEqual([1, 2, 3, 4]);
    expect(
      progress.some(
        (items) =>
          items.length === 2 &&
          items.some((item) => item.direction === "download") &&
          items.some((item) => item.direction === "upload"),
      ),
    ).toBe(true);
    expect(progress.at(-1)).toEqual([]);
    await s.store.load();
    expect(Object.keys(s.store.state.baselines.ctx!)).toHaveLength(4);
    expect(s.store.state.operations).toHaveLength(4);
    expect(s.store.state.journal).toEqual([]);
  });

  it.each([1, 3, 8])(
    "honors limit %s and cancels queued work while waiting for active transfers",
    async (limit) => {
      const s = await setup(
        Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [`file${i}`, String(i)]),
        ),
        {},
      );
      s.store.state.maxConcurrentTransfers = limit;
      const wait = gate(),
        started: string[] = [];
      const upload = s.remote.upload.bind(s.remote);
      s.remote.upload = async (...args) => {
        started.push(args[0]);
        await wait.promise;
        await upload(...args);
      };
      const task = s.executor.apply(
        s.review,
        s.review.changes.map((change) => ({ change, action: "upload" })),
        true,
      );
      await vi.waitFor(() => expect(started).toHaveLength(limit));
      s.executor.cancel();
      expect(s.executor.busy).toBe(true);
      wait.release();
      const result = await task;
      expect(started).toHaveLength(limit);
      expect(result.filter((op) => op.status === "Success")).toHaveLength(
        limit,
      );
      expect(result.filter((op) => op.status === "Cancelled")).toHaveLength(
        10 - limit,
      );
      expect(Object.keys(s.store.state.baselines.ctx!)).toHaveLength(limit);
      expect(s.store.state.journal).toEqual([]);
      expect(s.executor.busy).toBe(false);
    },
  );

  it("keeps independent successes when another concurrent transfer fails verification", async () => {
    const s = await setup({ a: "a", b: "b", c: "c" }, {});
    s.store.state.maxConcurrentTransfers = 3;
    const upload = s.remote.upload.bind(s.remote);
    s.remote.upload = async (...args) => {
      await upload(...args);
      if (args[0] === "b") s.remote.put("b", "damaged");
    };
    const result = await s.executor.apply(
      s.review,
      s.review.changes.map((change) => ({ change, action: "upload" })),
      true,
    );
    expect(result.map((op) => op.status)).toEqual([
      "Success",
      "Failed",
      "Success",
    ]);
    expect(
      Object.values(s.store.state.baselines.ctx!)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(["a", "c"]);
    expect(s.store.state.journal.map((op) => op.path)).toEqual(["b"]);
    expect(new Set(s.store.state.operations.map((op) => op.id)).size).toBe(3);
  });

  it("preserves earlier commits on persistence failure and drains active transfers before releasing busy", async () => {
    const s = await setup({ a: "a", b: "b", c: "c", d: "d" }, {});
    s.store.state.maxConcurrentTransfers = 3;
    const waits = new Map<string, ReturnType<typeof gate>>();
    const upload = s.remote.upload.bind(s.remote);
    s.remote.upload = async (...args) => {
      const wait = gate();
      waits.set(args[0], wait);
      await wait.promise;
      await upload(...args);
    };
    const save = s.store.save.bind(s.store);
    let failedSave = false;
    s.store.save = async () => {
      if (
        s.store.state.operations.some(
          (op) => op.path === "b" && op.status === "Success",
        )
      ) {
        failedSave = true;
        throw new Error("disk full");
      }
      await save();
    };
    const task = s.executor.apply(
      s.review,
      s.review.changes.map((change) => ({ change, action: "upload" })),
      true,
      false,
      (op) => {
        if (op.path === "a") s.executor.cancel();
      },
    );
    const outcome = task.then(
      () => null,
      (error: Error) => error,
    );
    await vi.waitFor(() => expect(waits.size).toBe(3));
    waits.get("a")!.release();
    await vi.waitFor(() =>
      expect(s.store.state.operations.some((op) => op.path === "a")).toBe(true),
    );
    waits.get("b")!.release();
    await vi.waitFor(() => expect(failedSave).toBe(true));
    expect(s.executor.busy).toBe(true);
    waits.get("c")!.release();
    expect((await outcome)?.message).toBe("disk full");
    expect(s.executor.busy).toBe(false);
    expect(waits.has("d")).toBe(false);
    await s.store.load();
    expect(
      Object.values(s.store.state.baselines.ctx!).map((entry) => entry.path),
    ).toEqual(["a"]);
    expect(s.store.state.operations.map((op) => op.path)).toEqual(["a"]);
    expect(s.store.state.journal.map((op) => op.path).sort()).toEqual([
      "b",
      "c",
    ]);
  });

  it("runs non-transfer actions as barriers between parallel transfers", async () => {
    const s = await setup({ a: "a", b: "b", c: "c", d: "d" }, {});
    s.store.state.maxConcurrentTransfers = 3;
    const wait = gate(),
      started: string[] = [];
    const upload = s.remote.upload.bind(s.remote);
    s.remote.upload = async (...args) => {
      started.push(args[0]);
      if (args[0] === "a") await wait.promise;
      await upload(...args);
    };
    const task = s.executor.apply(
      s.review,
      s.review.changes.map((change) => ({
        change,
        action: change.path === "b" ? "skip" : "upload",
      })),
      true,
    );
    await vi.waitFor(() => expect(started).toEqual(["a"]));
    expect(s.store.state.operations).toEqual([]);
    wait.release();
    const result = await task;
    expect(result.map((op) => op.status)).toEqual([
      "Success",
      "Skipped",
      "Success",
      "Success",
    ]);
    expect(s.store.state.operations.slice(0, 2).map((op) => op.path)).toEqual([
      "a",
      "b",
    ]);
  });
});

it.each(["local-path", "trash-remote"] as const)(
  "waits for active transfers before %s and finishes it before later transfers",
  async (action) => {
    const s = await setup(
      action === "local-path"
        ? { a: "a", c: "c", new: "original" }
        : { a: "a", c: "c" },
      { middle: "original" },
    );
    s.store.state.baselines.ctx = { middle: baseline("middle") };
    s.review.changes = reconcile(
      s.review.local,
      s.review.remote,
      s.store.state.baselines.ctx,
    );
    const middle = s.review.changes.find((change) => change.baseline)!;
    expect(middle.actions).toContain(action);
    const selected = [
      {
        change: s.review.changes.find((change) => change.path === "a")!,
        action: "upload" as const,
      },
      { change: middle, action },
      {
        change: s.review.changes.find((change) => change.path === "c")!,
        action: "upload" as const,
      },
    ];
    const wait = gate(),
      started: string[] = [];
    const upload = s.remote.upload.bind(s.remote);
    s.remote.upload = async (...args) => {
      started.push(args[0]);
      if (args[0] === "a") await wait.promise;
      await upload(...args);
    };
    const rename = vi.spyOn(s.remote, "rename"),
      trash = vi.spyOn(s.remote, "trash");
    const task = s.executor.apply(s.review, selected, true, true);
    await vi.waitFor(() => expect(started).toEqual(["a"]));
    expect(rename).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
    wait.release();
    const result = await task;
    expect(result.every((op) => op.status === "Success")).toBe(true);
    expect(s.store.state.operations.map((op) => op.action)).toEqual([
      "upload",
      action,
      "upload",
    ]);
  },
);

it("stops scheduling on persistence failure while another transfer is still running", async () => {
  const s = await setup({ a: "a", b: "b", c: "c" }, {});
  s.store.state.maxConcurrentTransfers = 2;
  const waits = new Map<string, ReturnType<typeof gate>>();
  const upload = s.remote.upload.bind(s.remote);
  s.remote.upload = async (...args) => {
    const wait = gate();
    waits.set(args[0], wait);
    await wait.promise;
    await upload(...args);
  };
  const save = s.store.save.bind(s.store);
  let failed = false;
  s.store.save = async () => {
    if (s.store.state.operations.length) {
      failed = true;
      throw new Error("disk full");
    }
    await save();
  };
  const outcome = s.executor
    .apply(
      s.review,
      s.review.changes.map((change) => ({ change, action: "upload" })),
      true,
    )
    .catch((error: Error) => error);
  await vi.waitFor(() => expect(waits.size).toBe(2));
  waits.get("a")!.release();
  await vi.waitFor(() => expect(failed).toBe(true));
  expect(s.executor.busy).toBe(true);
  expect(waits.has("c")).toBe(false);
  waits.get("b")!.release();
  expect(await outcome).toBeInstanceOf(Error);
  expect(s.executor.busy).toBe(false);
  expect(waits.has("c")).toBe(false);
  expect(s.store.state.baselines.ctx).toBeUndefined();
  expect(s.store.state.journal).toHaveLength(2);
});

it("scopes Apply checks to the operation paths and lets small files complete while another check is slow", async () => {
  const s = await setup({}, { a: "a", b: "b", c: "c" });
  s.store.state.maxConcurrentTransfers = 2;
  const wait = gate();
  const scan = s.local.scan.bind(s.local);
  const localScan = vi
    .spyOn(s.local, "scan")
    .mockImplementation(async (paths?: readonly string[]) => {
      expect(paths).toHaveLength(1);
      if (paths!.includes("a")) await wait.promise;
      return scan(paths);
    });
  const remoteScan = vi.spyOn(s.remote, "scan");
  const progress: TransferProgress[][] = [];
  const task = s.executor.apply(
    s.review,
    s.review.changes.map((change) => ({ change, action: "download" })),
    true,
    false,
    undefined,
    (items) => progress.push(items),
  );
  // This must complete before the slow file's check is released, without any
  // reliance on wall-clock timings or live network performance.
  await vi.waitFor(() =>
    expect(
      s.store.state.operations
        .filter((op) => op.status === "Success")
        .map((op) => op.path),
    ).toEqual(["b", "c"]),
  );
  expect(remoteScan.mock.calls.some((args) => args[0]?.includes("a"))).toBe(
    true,
  );
  expect(
    progress.some(
      (items) =>
        items.length === 2 && items.every((item) => item.phase === "preparing"),
    ),
  ).toBe(true);
  expect(s.executor.busy).toBe(true);
  wait.release();
  expect((await task).every((op) => op.status === "Success")).toBe(true);
  expect(localScan.mock.calls.every(([paths]) => paths?.length === 1)).toBe(
    true,
  );
  expect(remoteScan.mock.calls.every((args) => args[0]?.length === 1)).toBe(
    true,
  );
});

it("prepares queued metadata while bytes transfer and keeps the captured download version", async () => {
  const s = await setup({}, { a: "a", b: "b" });
  s.store.state.maxConcurrentTransfers = 1;
  const wait = gate();
  const read = s.remote.read.bind(s.remote);
  s.remote.read = async (file) => {
    if (typeof file !== "string" && file.path === "a") await wait.promise;
    return read(file);
  };
  const scan = vi.spyOn(s.remote, "scan");
  const task = s.executor.apply(
    s.review,
    s.review.changes.map((change) => ({ change, action: "download" })),
    true,
  );
  await vi.waitFor(() =>
    expect(scan.mock.calls.some(([paths]) => paths?.includes("b"))).toBe(true),
  );
  expect(s.local.files.b).toBeUndefined();
  expect(s.remote.calls).not.toContain("read:b");
  // The queued check has observed version 1. Matching downloaded content can
  // finish even if the remote metadata advances; the next scan sees version 2.
  s.remote.files.b!.version = "2";
  wait.release();
  const result = await task;
  expect(result.map((op) => op.status)).toEqual(["Success", "Success"]);
  expect(s.local.files.b).toBeDefined();
  expect(
    Object.values(s.store.state.baselines.ctx!)
      .map((entry) => entry.path)
      .sort(),
  ).toEqual(["a", "b"]);
  const saved = Object.values(s.store.state.baselines.ctx!).find(
    (entry) => entry.path === "b",
  )!;
  expect(saved.remote!.version).toBe("1");
  expect((await s.remote.scan()).files.b!.version).toBe("2");
});

it("bounds metadata preparation and keeps cancelled queued failures out of operation results", async () => {
  const s = await setup({}, { a: "a", b: "b", c: "c", d: "d" });
  s.store.state.maxConcurrentTransfers = 1;
  const wait = gate(),
    scan = s.remote.scan.bind(s.remote),
    read = s.remote.read.bind(s.remote);
  const checks: string[] = [];
  s.remote.scan = async (paths) => {
    checks.push(...(paths ?? []));
    if (paths?.includes("b")) throw new Error("offline");
    return scan(paths);
  };
  s.remote.read = async (file) => {
    await wait.promise;
    return read(file);
  };
  const task = s.executor.apply(
    s.review,
    s.review.changes.map((change) => ({ change, action: "download" })),
    true,
  );
  await vi.waitFor(() => expect(checks).toContain("b"));
  expect(checks).not.toContain("c");
  expect(checks).not.toContain("d");
  s.executor.cancel();
  wait.release();
  expect((await task).map((op) => op.status)).toEqual([
    "Success",
    "Cancelled",
    "Cancelled",
    "Cancelled",
  ]);
  expect(s.store.state.journal).toEqual([]);
});

it("does not prepare metadata across non-transfer barriers", async () => {
  const s = await setup({ a: "a", b: "b", c: "c" }, {});
  s.store.state.maxConcurrentTransfers = 1;
  const wait = gate(),
    upload = s.remote.upload.bind(s.remote),
    scan = vi.spyOn(s.remote, "scan");
  s.remote.upload = async (...args) => {
    if (args[0] === "a") await wait.promise;
    await upload(...args);
  };
  const task = s.executor.apply(
    s.review,
    s.review.changes.map((change) => ({
      change,
      action: change.path === "b" ? "skip" : "upload",
    })),
    true,
  );
  await vi.waitFor(() => expect(s.remote.calls).not.toContain("upload:a"));
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  expect(scan.mock.calls.some(([paths]) => paths?.includes("c"))).toBe(false);
  wait.release();
  expect((await task).map((op) => op.status)).toEqual([
    "Success",
    "Skipped",
    "Success",
  ]);
});

it("waits for shared journal durability before starting any content mutation", async () => {
  const s = await setup({ a: "a", b: "b" }, {});
  s.store.state.maxConcurrentTransfers = 2;
  const wait = gate(),
    save = s.store.save.bind(s.store);
  let saves = 0;
  s.store.save = async () => {
    if (++saves === 1) await wait.promise;
    await save();
  };
  const task = s.executor.apply(
    s.review,
    s.review.changes.map((change) => ({ change, action: "upload" })),
    true,
  );
  await vi.waitFor(() => expect(s.store.state.journal).toHaveLength(2));
  expect(saves).toBe(1);
  expect(s.remote.calls).toEqual([]);
  wait.release();
  expect((await task).every((op) => op.status === "Success")).toBe(true);
  await s.store.load();
  expect(s.store.state.journal).toEqual([]);
  expect(Object.keys(s.store.state.baselines.ctx!)).toHaveLength(2);
});

it("rolls back every member of a failed batched completion and retains their durable journals", async () => {
  const s = await setup({ a: "a", b: "b" }, {});
  s.store.state.maxConcurrentTransfers = 2;
  const save = s.store.save.bind(s.store);
  s.store.save = async () => {
    if (s.store.state.operations.length) throw new Error("disk full");
    await save();
  };
  await expect(
    s.executor.apply(
      s.review,
      s.review.changes.map((change) => ({ change, action: "upload" })),
      true,
    ),
  ).rejects.toThrow("disk full");
  await s.store.load();
  expect(s.store.state.operations).toEqual([]);
  expect(s.store.state.baselines.ctx).toBeUndefined();
  expect(s.store.state.journal.map((op) => op.path).sort()).toEqual(["a", "b"]);
  expect(
    s.store.state.journal.every((op) => op.status === "Running" && op.remoteId),
  ).toBe(true);
});

it("verifies MD5-only download sources while retaining old previews with both hashes", async () => {
  const s = await setup({}, { a: "legacy" });
  delete s.remote.files.a!.hashes.sha256;
  s.review.remote = await s.remote.scan();
  s.review.changes = reconcile(s.review.local, s.review.remote, {});
  expect((await s.apply("download"))[0]!.status).toBe("Success");
  expect(s.local.files.a!.hashes.md5).toBe(s.remote.files.a!.hashes.md5);
});

it("verifies new uploads when the provider first returns an MD5-only checksum", async () => {
  const s = await setup({ a: "a" }, {});
  const scan = s.local.scan.bind(s.local),
    upload = s.remote.upload.bind(s.remote);
  s.local.scan = async (paths, options?: { includeMd5?: boolean }) => {
    const snapshot = await scan(paths);
    if (!options?.includeMd5)
      for (const file of Object.values(snapshot.files)) delete file.hashes.md5;
    return snapshot;
  };
  s.remote.upload = async (...args) => {
    await upload(...args);
    delete s.remote.files[args[0]]!.hashes.sha256;
  };
  s.review.local = await s.local.scan();
  s.review.changes = reconcile(s.review.local, s.review.remote, {});
  const checks = vi.spyOn(s.local, "scan");
  expect((await s.apply("upload"))[0]!.status).toBe("Success");
  expect(checks.mock.calls.some(([, options]) => options?.includeMd5)).toBe(
    true,
  );
  expect(s.store.state.journal).toEqual([]);
});

it.each(["download", "use-remote"] as const)(
  "%s verifies the captured remote version with one preparation check",
  async (action) => {
    const s = await setup(
      action === "use-remote" ? { "a.pdf": "local" } : {},
      { "a.pdf": "remote" },
      action === "use-remote",
    );
    const captured = structuredClone(s.review.remote.files["a.pdf"]!);
    const scan = vi.spyOn(s.remote, "scan"),
      read = s.remote.read.bind(s.remote);
    s.remote.read = async (file) => {
      const received = await read(file);
      s.remote.put("a.pdf", "newer remote edit");
      return received;
    };
    const [result] = await s.apply(action);
    expect(result!.status).toBe("Success");
    expect(scan).toHaveBeenCalledOnce();
    expect(s.local.contents["a.pdf"]).toEqual(bytes("remote"));
    const saved = Object.values(s.store.state.baselines.ctx!)[0]!;
    expect(saved.remote).toEqual(captured);
    expect(saved.hash).toEqual(captured.hashes);
    expect(result!.after!.remote).toEqual(captured);
    const next = reconcile(
      await s.local.scan(),
      await s.remote.scan(),
      s.store.state.baselines.ctx!,
    );
    expect(next[0]!.classification).toBe("Remote modification");
  },
);

it("records the downloaded version when the remote is deleted during the transfer", async () => {
  const s = await setup({}, { "a.pdf": "original" });
  const read = s.remote.read.bind(s.remote),
    scan = vi.spyOn(s.remote, "scan");
  s.remote.read = async (file) => {
    const received = await read(file);
    delete s.remote.files["a.pdf"];
    delete s.remote.contents["a.pdf"];
    return received;
  };
  expect((await s.apply("download"))[0]!.status).toBe("Success");
  expect(scan).toHaveBeenCalledOnce();
  const saved = Object.values(s.store.state.baselines.ctx!)[0]!;
  expect(saved.remote!.id).toBe("id-a.pdf");
  expect(saved.hash).not.toBeNull();
  const next = reconcile(
    await s.local.scan(),
    await s.remote.scan(),
    s.store.state.baselines.ctx!,
  );
  expect(next[0]!.classification).toBe("Remote deletion");
});

it("requires no remote metadata requests after the downloaded bytes arrive", async () => {
  const s = await setup({}, { "a.pdf": "original" });
  const read = s.remote.read.bind(s.remote),
    scan = vi.spyOn(s.remote, "scan");
  s.remote.read = async (file) => {
    const received = await read(file);
    s.remote.fail = "scan";
    return received;
  };
  expect((await s.apply("download"))[0]!.status).toBe("Success");
  expect(scan).toHaveBeenCalledOnce();
  expect(s.store.state.journal).toEqual([]);
});

it("still rejects a local edit made while the download is in flight", async () => {
  const s = await setup({ "a.pdf": "local" }, { "a.pdf": "remote" }, true);
  const before = structuredClone(s.store.state.baselines),
    read = s.remote.read.bind(s.remote);
  s.remote.read = async (file) => {
    const received = await read(file);
    s.local.put("a.pdf", "my new local edit");
    return received;
  };
  expect((await s.apply("use-remote"))[0]!.status).toBe("Needs Rescan");
  expect(s.local.contents["a.pdf"]).toEqual(bytes("my new local edit"));
  expect(s.local.calls.some((call) => call.startsWith("write:"))).toBe(false);
  expect(s.store.state.baselines).toEqual(before);
});

it("still reads back the saved file and rejects damaged local content", async () => {
  const s = await setup({}, { "a.pdf": "original" });
  const write = s.local.write.bind(s.local),
    scan = vi.spyOn(s.remote, "scan");
  s.local.write = async (...args) => {
    await write(...args);
    s.local.put("a.pdf", "damaged after writing");
  };
  expect((await s.apply("download"))[0]!.status).toBe("Failed");
  expect(scan).toHaveBeenCalledOnce();
  expect(s.store.state.baselines.ctx).toBeUndefined();
  expect(s.store.state.journal).toHaveLength(1);
});

it("still rejects a changed local identity before saving a downloaded file", async () => {
  const s = await setup({}, { "a.pdf": "original" });
  const read = s.remote.read.bind(s.remote);
  s.remote.read = async (file) => {
    const received = await read(file);
    s.local.identity = "other-folder";
    return received;
  };
  expect((await s.apply("download"))[0]!.status).toBe("Needs Rescan");
  expect(s.local.calls).toEqual([]);
  expect(s.store.state.baselines.ctx).toBeUndefined();
});
