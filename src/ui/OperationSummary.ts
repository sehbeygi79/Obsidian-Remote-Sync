import type { Selection } from "../sync/types";

const OPERATIONS = ["add", "modify", "delete", "move"] as const;
type Kind = (typeof OPERATIONS)[number];
type Counts = Record<Kind, number>;
const LABELS: Record<Kind, string> = {
  add: "Add",
  modify: "Modify",
  delete: "Delete",
  move: "Move / rename",
};

export function operationSummary(selected: Selection[]) {
  const uploads: Counts = { add: 0, modify: 0, delete: 0, move: 0 };
  const downloads: Counts = { add: 0, modify: 0, delete: 0, move: 0 };
  let accepted = 0,
    skipped = 0;
  for (const { change, action } of selected) {
    switch (action) {
      case "upload":
      case "use-local":
        uploads[change.remote ? "modify" : "add"]++;
        break;
      case "download":
      case "use-remote":
        downloads[change.local ? "modify" : "add"]++;
        break;
      case "trash-remote":
        uploads.delete++;
        break;
      case "trash-local":
        downloads.delete++;
        break;
      case "local-path":
        uploads.move++;
        break;
      case "remote-path":
        downloads.move++;
        break;
      case "accept":
        accepted++;
        break;
      case "skip":
        skipped++;
        break;
    }
  }
  return { uploads, downloads, accepted, skipped };
}

export function renderOperationSummary(
  parent: HTMLElement,
  selected: Selection[],
): void {
  const summary = operationSummary(selected);
  parent.createEl("p", {
    text: "Review the changes that will be applied to each side.",
    cls: "remote-sync-summary-intro",
  });
  const groups = parent.createDiv({ cls: "remote-sync-operation-summary" });
  for (const [direction, title, subtitle] of [
    ["uploads", "Uploads", "Changes on Google Drive"],
    ["downloads", "Downloads", "Changes in materials/"],
  ] as const) {
    const counts = summary[direction];
    const group = groups.createDiv({
      cls: `remote-sync-summary-group remote-sync-summary-${direction}`,
    });
    const heading = group.createDiv({ cls: "remote-sync-summary-heading" });
    heading.createEl("h3", { text: title });
    heading.createEl("span", {
      text: String(OPERATIONS.reduce((sum, key) => sum + counts[key], 0)),
      cls: "remote-sync-summary-total",
    });
    group.createEl("p", { text: subtitle, cls: "remote-sync-summary-caption" });
    const list = group.createEl("ul", { cls: "remote-sync-summary-list" });
    for (const kind of OPERATIONS) {
      const item = list.createEl("li", {
        cls: `remote-sync-summary-${kind}${counts[kind] ? "" : " remote-sync-summary-zero"}`,
      });
      item.createEl("span", { text: LABELS[kind] });
      item.createEl("strong", { text: String(counts[kind]) });
    }
  }
  if (summary.accepted || summary.skipped) {
    const notes = parent.createDiv({ cls: "remote-sync-summary-notes" });
    if (summary.accepted)
      notes.createEl("p", {
        text: `${summary.accepted} accept verified equality · no file transfer`,
      });
    if (summary.skipped)
      notes.createEl("p", { text: `${summary.skipped} skipped · no changes` });
  }
  const overwrites = summary.uploads.modify + summary.downloads.modify;
  const deletes = summary.uploads.delete + summary.downloads.delete;
  if (overwrites || deletes) {
    const warnings = parent.createDiv({ cls: "remote-sync-warning" });
    if (overwrites)
      warnings.createEl("p", {
        text: `${overwrites} file${overwrites === 1 ? "" : "s"} will be overwritten without an extra copy.`,
      });
    if (deletes)
      warnings.createEl("p", {
        text: `${deletes} file${deletes === 1 ? "" : "s"} will be moved to trash.`,
      });
  }
}
