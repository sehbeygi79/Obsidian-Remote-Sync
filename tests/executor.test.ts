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
      const transfers: (TransferProgress | null)[] = [];
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
          .filter((event) => event !== null)
          .map((event) => [event.phase, event.transferred, event.total]),
      ).toEqual([
        ["preparing", 0, 8],
        ["transferring", 4, 8],
        ["transferring", 8, 8],
        ["verifying", 8, 8],
      ]);
      expect(transfers.at(-1)).toBeNull();
      expect(overall).toHaveBeenCalledOnce();
    },
  );

  it("a completed byte transfer with failed verification is still a failed file", async () => {
    const s = await setup({ "a.pdf": "original" }, {});
    s.remote.fail = "verify";
    const transfers: (TransferProgress | null)[] = [];
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
      transfers.some(
        (event) => event?.phase === "verifying" && event.transferred === 8,
      ),
    ).toBe(true);
    expect(transfers.at(-1)).toBeNull();
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
