import { App, Modal, Setting } from "obsidian";
import type { SyncStateStore } from "../sync/SyncStateStore";
import type { Action, Operation } from "../sync/types";
import { stamp } from "./format";
import { pageHeader } from "./PageHeader";
import { matchesFile, syncCommits, type SyncCommit } from "./HistoryGroups";

const ACTIONS: Record<Action, string> = {
  upload: "Upload",
  download: "Download",
  "use-local": "Overwrite remote",
  "use-remote": "Overwrite local",
  "trash-local": "Trash local",
  "trash-remote": "Trash remote",
  "local-path": "Move / rename remote",
  "remote-path": "Move / rename local",
  accept: "Accept equality",
  skip: "Skip",
};
function badge(parent: HTMLElement, text: string, tone: string): void {
  parent.createEl("span", {
    text,
    cls: `remote-sync-badge remote-sync-tone-${tone}`,
  });
}
function outcome(commit: SyncCommit): [string, string] {
  if (commit.counts.Failed)
    return [commit.counts.Success ? "Partial success" : "Failed", "conflict"];
  if (
    commit.unresolved.size ||
    commit.counts.Running ||
    commit.counts["Needs Rescan"]
  )
    return ["Needs review", "deletion"];
  if (commit.counts.Cancelled) return ["Cancelled", "deletion"];
  return commit.counts.Success
    ? ["Completed", "equal"]
    : ["Skipped", "neutral"];
}
function detail(parent: HTMLElement, label: string, value: string): void {
  const row = parent.createDiv({ cls: "remote-sync-meta-row" });
  row.createEl("span", { text: label, cls: "remote-sync-meta-label" });
  row.createEl("span", { text: value, cls: "remote-sync-meta-value" });
}

export class HistoryModal extends Modal {
  constructor(
    app: App,
    private store: SyncStateStore,
    private filter = "",
  ) {
    super(app);
  }
  onOpen(): void {
    this.modalEl.addClass("remote-sync-history");
    this.contentEl.addClass("remote-sync-history-content");
    pageHeader(this.contentEl, "Activity history");
    this.contentEl.createEl("p", {
      text: "Each commit is one confirmed sync action. Expand it to see the individual files.",
      cls: "remote-sync-page-intro",
    });
    const search = new Setting(
      this.contentEl.createDiv({ cls: "remote-sync-history-search" }),
    ).setName("Find a file");
    const area = this.contentEl.createDiv({
      cls: "remote-sync-history-content-area",
    });
    const render = () => {
      area.empty();
      const all = syncCommits(
        this.store.state.operations,
        this.store.state.journal,
      );
      const commits = all.filter((commit) =>
        commit.operations.some((operation) =>
          matchesFile(operation, this.filter),
        ),
      );
      const overview = area.createDiv({ cls: "remote-sync-history-overview" });
      for (const [label, count] of [
        ["Sync commits", commits.length],
        [
          "File operations",
          commits.reduce((n, c) => n + c.operations.length, 0),
        ],
        [
          "Need attention",
          commits.filter(
            (c) =>
              c.counts.Failed ||
              c.counts["Needs Rescan"] ||
              c.unresolved.size ||
              c.counts.Running,
          ).length,
        ],
      ] as const) {
        const stat = overview.createDiv({ cls: "remote-sync-history-stat" });
        stat.createEl("strong", { text: String(count) });
        stat.createEl("span", { text: label });
      }
      if (!commits.length) {
        const empty = area.createDiv({ cls: "remote-sync-empty" });
        empty.createEl("strong", {
          text: this.filter
            ? "No matching sync commits"
            : "No sync commits yet",
        });
        empty.createEl("p", {
          text: this.filter
            ? "Try a different file name or path."
            : "Completed, failed and cancelled sync actions will appear here.",
        });
      }
      const list = area.createDiv({ cls: "remote-sync-commit-list" });
      for (const commit of commits) {
        const card = list.createEl("details", { cls: "remote-sync-commit" });
        const summary = card.createEl("summary", {
          cls: "remote-sync-commit-heading",
        });
        const title = summary.createDiv({ cls: "remote-sync-commit-title" });
        title.createEl("strong", { text: `Sync · ${stamp(commit.startedAt)}` });
        title.createEl("span", {
          text: `${commit.operations.length} file operation${commit.operations.length === 1 ? "" : "s"}`,
          cls: "remote-sync-history-caption",
        });
        const [label, tone] = outcome(commit);
        badge(summary, label, tone);
        const body = card.createDiv({ cls: "remote-sync-commit-body" });
        const counts = body.createDiv({ cls: "remote-sync-counts" });
        for (const [status, caption, statusTone] of [
          ["Success", "succeeded", "equal"],
          ["Failed", "failed", "conflict"],
          ["Needs Rescan", "need rescan", "deletion"],
          ["Skipped", "skipped", "neutral"],
          ["Cancelled", "cancelled", "neutral"],
          ["Running", "unfinished", "deletion"],
        ] as const)
          if (commit.counts[status])
            badge(counts, `${commit.counts[status]} ${caption}`, statusTone);
        if (commit.unresolved.size)
          body.createEl("p", {
            text: "Unresolved entries remain in this commit. Inspect the files and run a fresh scan before acknowledging them.",
            cls: "remote-sync-warning",
          });
        const visible = commit.operations.filter((operation) =>
          matchesFile(operation, this.filter),
        );
        if (visible.length !== commit.operations.length)
          body.createEl("p", {
            text: `Showing ${visible.length} of ${commit.operations.length} files. The totals describe the whole commit.`,
            cls: "remote-sync-history-caption",
          });
        for (const operation of visible)
          this.fileEntry(body, operation, commit.unresolved.has(operation.id));
        const technical = body.createEl("details", {
          cls: "remote-sync-technical",
        });
        technical.createEl("summary", { text: "Commit details" });
        detail(technical, "Started", stamp(commit.startedAt));
        detail(
          technical,
          "Finished",
          commit.finishedAt
            ? stamp(commit.finishedAt)
            : "Unfinished / unresolved",
        );
        detail(technical, "Commit ID", commit.session);
        detail(technical, "Storage context", commit.context);
      }
      const scans = area.createEl("details", {
        cls: "remote-sync-history-scans",
      });
      scans.createEl("summary", {
        text: `Scan history · ${this.store.state.observations.length}`,
      });
      scans.createEl("p", {
        text: "Scans inspect files; they do not apply changes or create sync commits.",
        cls: "remote-sync-history-caption",
      });
      for (const scan of [...this.store.state.observations].reverse()) {
        const files = scan.files.filter(
          (file) =>
            !this.filter ||
            [file.path, file.localPath, file.remotePath].some((path) =>
              path
                .toLocaleLowerCase()
                .includes(this.filter.trim().toLocaleLowerCase()),
            ),
        );
        if (!files.length && this.filter.trim()) continue;
        const entry = scans.createEl("details", {
          cls: "remote-sync-scan-entry",
        });
        entry.createEl("summary", {
          text: `${stamp(scan.at)} · ${scan.status ?? "Success"} · ${files.length} files`,
        });
        if (scan.reason) entry.createEl("p", { text: scan.reason });
        for (const file of files) {
          const item = entry.createEl("details", {
            cls: "remote-sync-history-file",
          });
          item.createEl("summary", {
            text: `${file.path} · ${file.classification}`,
          });
          item.createEl("pre", { text: JSON.stringify(file, null, 2) });
        }
      }
      area.createEl("p", {
        text: `Showing retained history · ${this.store.state.retentionDays} days`,
        cls: "remote-sync-history-caption",
      });
    };
    search.addText((input) => {
      input.inputEl.setAttribute(
        "aria-label",
        "Search history by file name or path",
      );
      input.inputEl.placeholder = "File name or path…";
      input.setValue(this.filter).onChange((value) => {
        this.filter = value;
        render();
      });
    });
    render();
  }
  private fileEntry(
    parent: HTMLElement,
    operation: Operation,
    unresolved: boolean,
  ): void {
    const item = parent.createEl("details", {
      cls: "remote-sync-history-file",
    });
    const summary = item.createEl("summary");
    const name = summary.createDiv({ cls: "remote-sync-history-file-name" });
    name.createEl("strong", {
      text: operation.path.split("/").pop() ?? operation.path,
    });
    name.createEl("span", {
      text: ACTIONS[operation.action],
      cls: "remote-sync-history-caption",
    });
    badge(
      summary,
      unresolved ? "Unresolved" : operation.status,
      unresolved || operation.status === "Needs Rescan"
        ? "deletion"
        : operation.status === "Success"
          ? "equal"
          : operation.status === "Failed"
            ? "conflict"
            : "neutral",
    );
    const body = item.createDiv({ cls: "remote-sync-history-file-body" });
    body.createEl("p", {
      text: operation.path,
      cls: "remote-sync-history-path",
    });
    if (operation.reason) body.createEl("p", { text: operation.reason });
    detail(body, "Started", stamp(operation.at));
    detail(body, "Finished", stamp(operation.finishedAt));
    detail(body, "Local before", operation.before.local?.path ?? "Missing");
    detail(body, "Remote before", operation.before.remote?.path ?? "Missing");
    if (operation.after) {
      detail(body, "Local after", operation.after.local?.path ?? "Missing");
      detail(body, "Remote after", operation.after.remote?.path ?? "Missing");
    }
    const technical = body.createEl("details", {
      cls: "remote-sync-technical",
    });
    technical.createEl("summary", { text: "Hashes and technical details" });
    technical.createEl("pre", { text: JSON.stringify(operation, null, 2) });
  }
}
