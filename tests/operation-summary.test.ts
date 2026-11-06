import { describe, expect, it } from "vitest";
import {
  operationSummary,
  renderOperationSummary,
} from "../src/ui/OperationSummary";
import type { Action, Selection } from "../src/sync/types";
import { reconcile } from "../src/sync/ReconciliationEngine";
import { file, snapshot } from "./helpers";
import { UiElement } from "./ui-host";

function selected(action: Action, local = true, remote = true): Selection {
  const change = reconcile(snapshot([file()]), snapshot(), {})[0]!;
  change.local = local ? file() : null;
  change.remote = remote ? file("a.pdf", "original", true) : null;
  return { action, change };
}

describe("operation confirmation summary", () => {
  it("counts each actual action by destination, including restores and moves", () => {
    const summary = operationSummary([
      selected("upload", true, false),
      selected("use-local"),
      selected("upload"),
      selected("use-local", true, false),
      selected("download", false),
      selected("use-remote"),
      selected("download"),
      selected("use-remote", false),
      selected("trash-remote"),
      selected("trash-local"),
      selected("local-path"),
      selected("remote-path"),
      selected("accept"),
      selected("skip"),
    ]);
    expect(summary).toEqual({
      uploads: { add: 2, modify: 2, delete: 1, move: 1 },
      downloads: { add: 2, modify: 2, delete: 1, move: 1 },
      accepted: 1,
      skipped: 1,
    });
  });
  it("renders both directions with all four nested counts and separate non-transfer notes", () => {
    const root = new UiElement();
    renderOperationSummary(root as unknown as HTMLElement, [
      selected("upload", true, false),
      selected("accept"),
      selected("skip"),
    ]);
    const groups = root.querySelector(
      ".remote-sync-operation-summary",
    )!.children;
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.querySelector("h3")!.textContent)).toEqual([
      "Uploads",
      "Downloads",
    ]);
    expect(groups.map((g) => g.querySelector("ul")!.children.length)).toEqual([
      4, 4,
    ]);
    expect(
      root.querySelector(".remote-sync-summary-notes")!.children,
    ).toHaveLength(2);
    expect(root.querySelector(".remote-sync-warning")).toBeNull();
  });
  it("keeps overwrite and trash effects explicit", () => {
    const root = new UiElement();
    renderOperationSummary(root as unknown as HTMLElement, [
      selected("use-local"),
      selected("trash-local"),
    ]);
    const warnings = root.querySelector(".remote-sync-warning")!;
    expect(warnings.children.map((el) => el.textContent)).toEqual([
      "1 file will be overwritten without an extra copy.",
      "1 file will be moved to trash.",
    ]);
  });
});
