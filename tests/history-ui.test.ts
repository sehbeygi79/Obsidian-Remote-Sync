import { beforeEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { Operation } from "../src/sync/types";
import { HistoryModal } from "../src/ui/HistoryModal";
import { matchesFile, syncCommits } from "../src/ui/HistoryGroups";
import { file, memoryStore } from "./helpers";
import { Modal, type UiElement } from "./ui-host";

function operation(id: string, changes: Partial<Operation> = {}): Operation {
  return {
    id,
    session: "batch-1",
    context: "device:account:folder",
    at: 1000,
    finishedAt: 2000,
    path: `${id}.pdf`,
    action: "upload",
    status: "Success",
    before: { local: file(`${id}.pdf`), remote: null },
    ...changes,
  };
}
const text = (element: UiElement): string =>
  element
    .all(() => true)
    .map((node) => node.textContent)
    .join("\n");

describe("sync commit history", () => {
  beforeEach(() => {
    Modal.opened = [];
  });
  it("groups each session, isolates storage contexts and sorts newest first without changing records", () => {
    const records = [
      operation("b", { at: 1200, finishedAt: 2400 }),
      operation("a"),
      operation("c", { session: "batch-2", at: 4000 }),
      operation("d", { context: "device:other-account:folder", at: 3000 }),
    ];
    const original = structuredClone(records);
    const commits = syncCommits(records);
    expect(commits).toHaveLength(3);
    expect(commits.map((c) => c.operations.map((o) => o.id))).toEqual([
      ["c"],
      ["d"],
      ["a", "b"],
    ]);
    expect(commits[2]).toMatchObject({
      startedAt: 1000,
      finishedAt: 2400,
      counts: { Success: 2 },
    });
    expect(records).toEqual(original);
  });
  it("deduplicates persisted journal records, keeps the final status, and preserves unfinished commits", () => {
    const running = operation("a", {
      status: "Running",
      finishedAt: undefined,
    });
    const unfinished = operation("b", {
      session: "batch-2",
      status: "Running",
      finishedAt: undefined,
    });
    const commits = syncCommits([operation("a")], [running, unfinished]);
    expect(commits).toHaveLength(2);
    expect(commits.reduce((n, c) => n + c.operations.length, 0)).toBe(2);
    const final = commits.find((c) => c.session === "batch-1")!;
    expect(final.counts.Success).toBe(1);
    expect(final.unresolved.has("a")).toBe(true);
    expect(final.finishedAt).toBeUndefined();
    expect(commits.every((c) => c.finishedAt === undefined)).toBe(true);
  });
  it("matches renamed file paths and does not merge entries with a missing session", () => {
    const renamed = operation("a", {
      after: { local: file("renamed/NEW.pdf"), remote: null },
    });
    expect(matchesFile(renamed, " renamed/new ")).toBe(true);
    expect(matchesFile(renamed, "a.pdf")).toBe(true);
    expect(matchesFile(renamed, "absent")).toBe(false);
    expect(
      syncCommits([
        operation("a", { session: "" }),
        operation("b", { session: "" }),
      ]),
    ).toHaveLength(2);
  });
  it("renders one expandable commit for multiple files, keeping scans separate", () => {
    const store = memoryStore();
    store.state.operations = [
      operation("a"),
      operation("b"),
      operation("c", {
        session: "batch-2",
        status: "Failed",
        reason: "Network failed",
      }),
    ];
    store.state.observations = [
      { at: 5000, context: "device:account:folder", files: [] },
    ];
    const modal = new HistoryModal({} as App, store);
    modal.open();
    const root = (modal as unknown as Modal).contentEl;
    const cards = root.all((el) => el.classes.has("remote-sync-commit"));
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.tag === "details" && !card.open)).toBe(
      true,
    );
    expect(
      root.all((el) => el.classes.has("remote-sync-history-file")),
    ).toHaveLength(3);
    expect(text(root)).toContain("2 file operations");
    expect(text(root)).toContain("Scan history · 1");
    expect(text(root)).toContain("Network failed");
    expect(root.all((el) => el.tag === "pre")).toHaveLength(3);
  });
  it("filters to matching files but preserves whole-commit totals and mixed outcome", () => {
    const store = memoryStore();
    store.state.operations = [
      operation("a"),
      operation("b", { status: "Failed" }),
    ];
    const modal = new HistoryModal({} as App, store, "a.pdf");
    modal.open();
    const root = (modal as unknown as Modal).contentEl;
    expect(root.all((el) => el.classes.has("remote-sync-commit"))).toHaveLength(
      1,
    );
    expect(
      root.all((el) => el.classes.has("remote-sync-history-file")),
    ).toHaveLength(1);
    expect(text(root)).toContain("Partial success");
    expect(text(root)).toContain("Showing 1 of 2 files");
    const input = root.querySelector("input")!;
    input.value = "no-match";
    input.listeners.change!();
    expect(text(root)).toContain("No matching sync commits");
    expect(root.all((el) => el.classes.has("remote-sync-commit"))).toHaveLength(
      0,
    );
  });
  it("keeps journal-only operations visible with an unresolved warning", () => {
    const store = memoryStore();
    store.state.journal = [
      operation("a", { status: "Running", finishedAt: undefined }),
    ];
    const modal = new HistoryModal({} as App, store);
    modal.open();
    const root = (modal as unknown as Modal).contentEl;
    expect(text(root)).toContain("Needs review");
    expect(text(root)).toContain("Unresolved entries remain");
    expect(text(root)).toContain("Unresolved");
  });
});

it("filters sync commits and scan observations by remote without deleting other history", () => {
  const store = memoryStore();
  store.state.operations = [
    operation("one", { context: "context-one", remoteName: "First remote" }),
    operation("two", { context: "context-two", remoteName: "Other remote" }),
  ];
  store.state.observations = [
    { at: 1000, context: "context-one", files: [] },
    { at: 2000, context: "context-two", files: [] },
  ];
  const modal = new HistoryModal({} as App, store, "", "context-one");
  modal.open();
  const root = (modal as unknown as Modal).contentEl;
  expect(root.all((el) => el.classes.has("remote-sync-commit"))).toHaveLength(
    1,
  );
  expect(text(root.querySelector(".remote-sync-commit-list")!)).toContain(
    "First remote",
  );
  expect(text(root)).toContain("Scan history · 1");
  const filter = root.querySelector("select")!;
  filter.value = "";
  filter.listeners.change!();
  expect(root.all((el) => el.classes.has("remote-sync-commit"))).toHaveLength(
    2,
  );
  expect(text(root)).toContain("Scan history · 2");
  expect(store.state.operations).toHaveLength(2);
  modal.close();
});
