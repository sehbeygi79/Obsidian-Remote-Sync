import { describe, it, expect } from "vitest";
import { freshState, SyncStateStore } from "../src/sync/SyncStateStore";
import { baseline } from "./helpers";
function memory() {
  const data = new Map<string, string>();
  const storage = {
    read: async (p: string) => {
      if (!data.has(p)) throw new Error("missing");
      return data.get(p)!;
    },
    write: async (p: string, v: string) => {
      data.set(p, v);
    },
    exists: async (p: string) => data.has(p),
  };
  return { data, storage };
}
describe("device state recovery", () => {
  it("roundtrips baseline without changing identity", async () => {
    const { storage } = memory(),
      a = new SyncStateStore(storage, "s");
    a.state.baselines.ctx = { "a.pdf": baseline() };
    a.state.ignorePatterns = [".obsidian/", "*.tmp"];
    await a.save();
    const b = new SyncStateStore(storage, "s");
    await b.load();
    expect(b.state).toEqual(a.state);
  });
  it("recovers previous valid slot after interrupted write", async () => {
    const { data, storage } = memory(),
      a = new SyncStateStore(storage, "s");
    await a.save();
    a.state.retentionDays = 123;
    await a.save();
    data.set("s.0.json", "broken");
    const b = new SyncStateStore(storage, "s");
    await b.load();
    expect(b.state.retentionDays).toBe(90);
  });
  it("fully corrupt state fails closed, never empties baseline silently", async () => {
    const { data, storage } = memory();
    data.set("s.0.json", "broken");
    await expect(new SyncStateStore(storage, "s").load()).rejects.toThrow(
      "corrupt",
    );
  });
  it("detects modified payload checksum", async () => {
    const { data, storage } = memory(),
      a = new SyncStateStore(storage, "s");
    await a.save();
    const slot = JSON.parse(data.get("s.1.json")!);
    slot.payload = JSON.stringify(freshState());
    data.set("s.1.json", JSON.stringify(slot));
    await expect(new SyncStateStore(storage, "s").load()).rejects.toThrow(
      "corrupt",
    );
  });
  it("unresolved journal survives restart and retention pruning", async () => {
    const { storage } = memory(),
      a = new SyncStateStore(storage, "s");
    a.state.journal = [
      {
        id: "op",
        session: "session",
        at: 1,
        context: "ctx",
        path: "a",
        action: "upload",
        status: "Running",
        before: { local: null, remote: null },
        remoteId: "reserved",
      },
    ];
    a.prune();
    await a.save();
    const b = new SyncStateStore(storage, "s");
    await b.load();
    expect(b.state.journal[0]!.remoteId).toBe("reserved");
  });
  it("state write failure poisons subsequent execution persistence", async () => {
    const s = new SyncStateStore(
      {
        read: async () => "",
        exists: async () => false,
        write: async () => {
          throw new Error("disk full");
        },
      },
      "s",
    );
    await expect(s.save()).rejects.toThrow("disk full");
    await expect(s.save()).rejects.toThrow("persistence");
  });
});
