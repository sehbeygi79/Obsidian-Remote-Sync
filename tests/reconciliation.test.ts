import { describe, it, expect } from "vitest";
import { reconcile, equal } from "../src/sync/ReconciliationEngine";
import { baseline, file, snapshot } from "./helpers";
import type { Baseline, FileState } from "../src/sync/types";
const cases: [
  string,
  FileState | null,
  FileState | null,
  Baseline | null,
  string,
][] = [
  ["first local", file(), null, null, "Local addition"],
  [
    "first remote",
    null,
    file("a.pdf", "original", true),
    null,
    "Remote addition",
  ],
  [
    "first equal",
    file(),
    file("a.pdf", "original", true),
    null,
    "Equal contents",
  ],
  [
    "first conflict",
    file(),
    file("a.pdf", "new", true),
    null,
    "First-sync conflict",
  ],
  [
    "unchanged",
    file(),
    file("a.pdf", "original", true),
    baseline(),
    "Synchronized",
  ],
  [
    "local edit",
    file("a.pdf", "local"),
    file("a.pdf", "original", true),
    baseline(),
    "Local modification",
  ],
  [
    "remote edit",
    file(),
    file("a.pdf", "remote", true),
    baseline(),
    "Remote modification",
  ],
  [
    "both differ",
    file("a.pdf", "local"),
    file("a.pdf", "remote", true),
    baseline(),
    "Both sides modified",
  ],
  [
    "both same edit",
    file("a.pdf", "same"),
    file("a.pdf", "same", true),
    baseline(),
    "Equal contents",
  ],
  [
    "local deletion",
    null,
    file("a.pdf", "original", true),
    baseline(),
    "Local deletion",
  ],
  ["remote deletion", file(), null, baseline(), "Remote deletion"],
  [
    "local deletion remote edit",
    null,
    file("a.pdf", "remote", true),
    baseline(),
    "Delete-vs-edit conflict",
  ],
  [
    "remote deletion local edit",
    file("a.pdf", "local"),
    null,
    baseline(),
    "Edit-vs-delete conflict",
  ],
  ["both deleted", null, null, baseline(), "Both deleted"],
];
describe("three-way matrix", () => {
  it.each(cases)("%s", (_name, l, r, b, classification) => {
    const rows = reconcile(
      snapshot(l ? [l] : []),
      snapshot(r ? [r] : []),
      b ? { [b.key]: b } : {},
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.classification).toBe(classification);
    expect(rows[0]!.actions).toContain("skip");
    expect(rows[0]!.actions).not.toContain("keep-both");
  });
  it("empty first sync has no operations", () =>
    expect(reconcile(snapshot(), snapshot(), {})).toEqual([]));
  it("equal timestamps cannot establish equality", () =>
    expect(equal(file("a", "one"), file("a", "two"))).toBe(false));
  it("different timestamps do not imply changes", () =>
    expect(
      reconcile(
        snapshot([file()]),
        snapshot([file("a.pdf", "original", true, 99999999)]),
        { a: baseline() },
      )[0]!.classification,
    ).toBe("Synchronized"));
  it("ignores newer timestamp when hash equals baseline", () =>
    expect(
      reconcile(
        snapshot([file("a.pdf", "original", false, 999999999)]),
        snapshot([file("a.pdf", "edit", true, 1)]),
        { a: baseline() },
      )[0]!.suggested,
    ).toBe("use-remote"));
  it("requires compatible hashes", () => {
    const a = file(),
      b = file();
    a.hashes = { sha256: a.hashes.sha256 };
    b.hashes = { md5: b.hashes.md5 };
    expect(equal(a, b)).toBe(false);
  });
  it("compares MD5 when remote SHA256 is absent", () => {
    const a = file(),
      b = file();
    b.hashes = { md5: b.hashes.md5 };
    expect(equal(a, b)).toBe(true);
  });
  it("does not mutate baseline or snapshots while scanning", () => {
    const b = { a: baseline() },
      l = snapshot([file()]),
      r = snapshot([file("a.pdf", "new", true)]);
    const before = JSON.stringify([b, l, r]);
    reconcile(l, r, b);
    expect(JSON.stringify([b, l, r])).toBe(before);
  });
  it("tombstone recreation is an addition, not a deletion", () => {
    const b = baseline();
    b.hash = null;
    expect(
      reconcile(snapshot([file()]), snapshot(), { a: b })[0]!.category,
    ).toBe("addition");
  });
});
describe("renames and moves", () => {
  it("unique local unchanged-content rename", () => {
    const rows = reconcile(
      snapshot([file("new.pdf")]),
      snapshot([file("a.pdf", "original", true)]),
      { a: baseline() },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.classification).toBe("Local rename / move");
  });
  it("desktop stable file identity detects a rename with edited content", () => {
    const b = baseline();
    b.local!.localId = "device:inode:birth";
    const l = file("new.pdf", "edited");
    l.localId = b.local!.localId;
    const c = reconcile(
      snapshot([l]),
      snapshot([file("a.pdf", "original", true)]),
      { [b.key]: b },
    )[0]!;
    expect(c.category).toBe("rename");
    expect(c.explanation).toContain("content both differ");
  });
  it("remote rename follows stable ID", () => {
    const r = {
      ...file("nested/new.pdf", "modified", true),
      id: baseline().remoteId,
    };
    const c = reconcile(snapshot([file()]), snapshot([r]), {
      a: baseline(),
    })[0]!;
    expect(c.category).toBe("rename");
    expect(c.explanation).toContain("content both differ");
  });
  it("local directory move produces individual path changes", () => {
    const a = baseline("old/a"),
      b = baseline("old/b", "other");
    const rows = reconcile(
      snapshot([file("new/a"), file("new/b", "other")]),
      snapshot([file("old/a", "original", true), file("old/b", "other", true)]),
      { a, b },
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((c) => c.category === "rename")).toBe(true);
  });
  it("remote directory move preserves identities", () => {
    const a = baseline("old/a"),
      b = baseline("old/b", "other");
    const rows = reconcile(
      snapshot([file("old/a"), file("old/b", "other")]),
      snapshot([
        { ...file("new/a", "original", true), id: a.remoteId },
        { ...file("new/b", "other", true), id: b.remoteId },
      ]),
      { a, b },
    );
    expect(rows.every((c) => c.category === "rename")).toBe(true);
  });
  it("ambiguous same-hash local candidates fall back", () => {
    const rows = reconcile(
      snapshot([file("one"), file("two")]),
      snapshot([file("a.pdf", "original", true)]),
      { a: baseline() },
    );
    expect(rows.some((c) => c.category === "rename")).toBe(false);
    expect(rows[0]!.explanation).toContain("ambiguous");
  });
  it("ambiguous deleted identities are never paired", () => {
    const rows = reconcile(
      snapshot([file("new")]),
      snapshot([file("a", "original", true), file("b", "original", true)]),
      { a: baseline("a"), b: baseline("b") },
    );
    expect(rows.some((c) => c.category === "rename")).toBe(false);
  });
  it("local rename plus edit reports uncertain identity", () => {
    const rows = reconcile(
      snapshot([file("new", "edited")]),
      snapshot([file("a.pdf", "original", true)]),
      { a: baseline() },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.explanation).toContain("cannot be identified reliably");
  });
  it("conflicting destinations require explicit path selection", () => {
    const r = { ...file("remote", "original", true), id: baseline().remoteId };
    const c = reconcile(snapshot([file("local")]), snapshot([r]), {
      a: baseline(),
    })[0]!;
    expect(c.classification).toBe("Conflicting paths");
    expect(c.actions).toEqual(["local-path", "remote-path", "skip"]);
  });
  it("matching moves on both sides require explicit acceptance of the new baseline path", () => {
    const b = baseline(),
      remote = { ...file("new.pdf", "original", true), id: b.remoteId };
    const c = reconcile(snapshot([file("new.pdf")]), snapshot([remote]), {
      [b.key]: b,
    })[0]!;
    expect(c.classification).toBe("Equal contents");
    expect(c.actions).toContain("accept");
  });
  it("blocked subtree cannot generate deletion actions", () => {
    const r = snapshot();
    r.blocked = ["a.pdf"];
    expect(
      reconcile(snapshot([file()]), r, { a: baseline() })[0]!.actions,
    ).toEqual(["skip"]);
  });
  it("rejects case colliding paths", () =>
    expect(() =>
      reconcile(snapshot([file("A"), file("a")]), snapshot(), {}),
    ).toThrow("collision"));
});
