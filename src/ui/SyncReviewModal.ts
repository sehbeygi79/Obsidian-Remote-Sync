import { App, Modal, Setting, setIcon } from "obsidian";
import type RemoteSyncPlugin from "../main";
import type { Action, Category, Review, TransferProgress } from "../sync/types";
import { equal } from "../sync/ReconciliationEngine";
import { massDeletion } from "../sync/SyncExecutor";
import { confirm, form } from "./Dialogs";
import { FolderBrowser } from "./FolderBrowser";
import { HistoryModal } from "./HistoryModal";
import { size, stamp } from "./format";
import { notify, notifySyncResult } from "./Notifications";
import { photoSelector } from "./PhotoSelector";
import { pageHeader } from "./PageHeader";
import { renderOperationSummary } from "./OperationSummary";
import { syncCommits } from "./HistoryGroups";
const LABELS: Record<Action, string> = {
  upload: "Upload / Restore Remote",
  download: "Download / Restore Local",
  "use-local": "Use Local — overwrite remote",
  "use-remote": "Use Remote — overwrite local",
  "trash-local": "Trash Local",
  "trash-remote": "Trash Remote",
  "local-path": "Apply Local Path to Remote",
  "remote-path": "Apply Remote Path to Local",
  accept: "Accept verified equality",
  skip: "Skip",
};
const CATEGORIES: Record<Category, string> = {
  addition: "Added",
  modification: "Modified",
  deletion: "Deleted",
  rename: "Moved / renamed",
  conflict: "Conflicts",
  equal: "In sync",
  blocked: "Blocked",
};
interface BatchProgress {
  total: number;
  completed: number;
  success: number;
  failed: number;
  rescan: number;
  skipped: number;
  cancelled: number;
  path: string;
  phase: "running" | "complete" | "stopped" | "failed";
}
function metadata(parent: HTMLElement, label: string, value: string): void {
  const row = parent.createDiv({ cls: "remote-sync-meta-row" });
  row.createEl("span", { text: label, cls: "remote-sync-meta-label" });
  row.createEl("span", { text: value, cls: "remote-sync-meta-value" });
}
function actionWarning(action: Action): string {
  if (action === "use-local") return "Replaces the remote file’s contents.";
  if (action === "use-remote") return "Replaces the local file’s contents.";
  if (action === "trash-local") return "Moves the local file to trash.";
  if (action === "trash-remote") return "Moves the remote file to Drive trash.";
  return "";
}
export class SyncReviewModal extends Modal {
  // Modal.open() owns `selection` for restoring editor focus.
  private selectedActions = new Map<string, Action>();
  private choices = new Map<string, Action>();
  private filter: Category | "all" = "all";
  private applying = false;
  private consumed = new Set<string>();
  private expandedFiles = new Set<string>();
  private expandedGroups = new Set<string>();
  private batchProgress: BatchProgress | null = null;
  private progressStatusEl?: HTMLElement;
  private progressFileEl?: HTMLElement;
  private progressTrackEl?: HTMLProgressElement;
  private scanning = false;
  private closed = false;
  private scanError: string | null = null;
  private scanStatusEl?: HTMLElement;
  private fileTransfers: TransferProgress[] = [];
  private fileTransferEl?: HTMLElement;
  constructor(
    app: App,
    private plugin: RemoteSyncPlugin,
    private review?: Review,
  ) {
    super(app);
  }
  onOpen(): void {
    this.modalEl.addClass("remote-sync-review");
    this.contentEl.addClass("remote-sync-review-content");
    this.render();
  }
  onClose(): void {
    this.closed = true;
    if (this.applying) this.plugin.executor?.cancel();
    this.contentEl.empty();
  }
  private render(): void {
    const el = this.contentEl;
    const fileScrollTop =
      el.querySelector<HTMLElement>(".remote-sync-files")?.scrollTop ?? 0;
    el.empty();
    const header = pageHeader(el, "Review Status");
    header.addClass("remote-sync-review-header");
    const review = this.review;
    const unlocked = this.plugin.credentials.unlocked;
    const context = review?.context ?? (unlocked ? this.plugin.context() : "");
    const ready =
      !!review &&
      !this.scanning &&
      !this.scanError &&
      unlocked &&
      !!this.plugin.executor &&
      this.plugin.context() === review.context &&
      (review.selectionVersion === undefined ||
        review.selectionVersion === this.plugin.selectionVersion) &&
      (!review.profileId ||
        review.profileId === this.plugin.credentials.activeRemote?.id);
    const changes = ready ? review!.changes : [];
    const last = Math.max(
      0,
      ...Object.values(this.plugin.state.state.baselines[context] ?? {}).map(
        (b) => b.syncedAt,
      ),
    );
    const overview = el.createDiv({ cls: "remote-sync-review-overview" });
    const locations = overview.createEl("section", {
      cls: "remote-sync-locations",
      attr: { "aria-label": "Sync folders" },
    });
    const localField = locations.createDiv({ cls: "remote-sync-scope-field" });
    const selectedLocal = this.plugin.localFolder;
    photoSelector(
      localField,
      this.plugin.localFolders.map((path) => ({
        id: path,
        title: path ? `${path}/` : "Entire vault (./)",
        description: path ? "Folder in this vault" : "All vault folders",
        icon: path ? "folder" : "vault",
      })),
      selectedLocal,
      "Local folder",
      (path) => {
        this.plugin.run(async () => {
          await this.plugin.selectLocalFolder(path);
          this.review = undefined;
          await this.loadReview();
        });
      },
      this.applying || this.scanning,
      {
        heading: "Local Folder",
        addLabel: "Add local",
        onAdd: () =>
          this.plugin.run(async () => {
            const input = await form(
              this.app,
              "Add local folder",
              [
                {
                  key: "path",
                  label: "Vault-relative folder path",
                  value: "./",
                },
              ],
              "Enter a vault-relative folder path, or ./ for the entire vault.",
            );
            if (!input) return;
            await this.plugin.addLocalFolder(input.path!);
            this.review = undefined;
            await this.loadReview();
            if (!this.closed) this.render();
          }),
        onRemove: (path) =>
          this.plugin.run(async () => {
            if (
              await confirm(
                this.app,
                "Remove local folder",
                `Remove ${path ? `${path}/` : "the entire vault"} from the saved choices? Files and sync history are kept.`,
              )
            ) {
              await this.plugin.removeLocalFolder(path);
              this.review = undefined;
              await this.loadReview();
              if (!this.closed) this.render();
            }
          }),
        canRemove: () => this.plugin.localFolders.length > 1,
      },
    );
    const remoteField = locations.createDiv({ cls: "remote-sync-scope-field" });
    const profiles = unlocked ? (this.plugin.credentials.remotes ?? []) : [];
    if (profiles.length) {
      photoSelector(
        remoteField,
        profiles.map((remote) => ({
          id: remote.id,
          title: remote.name,
          description: this.plugin.credentials.account(remote.accountRef)
            .accountEmail,
          account: this.plugin.credentials.account(remote.accountRef),
        })),
        this.plugin.credentials.activeRemote?.id ?? "",
        "Remote profile",
        (id) => {
          if (this.plugin.working || this.plugin.executor?.busy) {
            notify(
              "Remote Sync: finish or cancel the active operation before switching remotes.",
              "warning",
            );
            return;
          }
          this.plugin.run(async () => {
            try {
              await this.plugin.selectRemote(id);
              this.review = undefined;
              await this.loadReview();
            } finally {
              if (!this.closed) this.render();
            }
          });
        },
        this.applying || this.scanning,
        {
          heading: "Remote Folder",
          addLabel: "Add remote",
          onAdd: () =>
            new FolderBrowser(
              this.app,
              this.plugin,
              async () => {
                this.review = undefined;
                await this.loadReview();
                if (!this.closed) this.render();
              },
              this.plugin.credentials.activeRemote?.accountRef,
            ).open(),
          onRename: (id) =>
            this.plugin.run(async () => {
              await this.plugin.renameRemote(id);
              this.review = undefined;
              await this.loadReview();
              if (!this.closed) this.render();
            }),
          onRemove: (id) =>
            this.plugin.run(async () => {
              await this.plugin.removeRemote(id);
              this.review = undefined;
              await this.loadReview();
              if (!this.closed) this.render();
            }),
        },
      );
    } else {
      photoSelector(
        remoteField,
        [
          {
            id: "__no_remote__",
            title: unlocked ? "No remote selected" : "Unlock to add a remote",
            description: "Browse Google Drive folders",
            icon: "cloud",
          },
        ],
        "__no_remote__",
        "Remote profile",
        () => {},
        this.applying || this.scanning,
        {
          heading: "Remote Folder",
          addLabel: "Add remote",
          onAdd: () =>
            new FolderBrowser(
              this.app,
              this.plugin,
              async () => {
                this.review = undefined;
                await this.loadReview();
                if (!this.closed) this.render();
              },
              this.plugin.credentials.activeRemote?.accountRef ??
                (unlocked
                  ? (this.plugin.credentials.configuration.activeAccountId ??
                    this.plugin.credentials.accounts[0]?.id)
                  : undefined),
            ).open(),
        },
      );
    }
    metadata(locations, "Last Sync", stamp(last));
    const counts = new Map<Category, number>();
    for (const c of changes)
      counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
    const toolbarSection = overview.createEl("section", {
      cls: "remote-sync-toolbar",
      attr: { "aria-label": "Review controls" },
    });
    const filterSection = toolbarSection.createEl("section", {
      cls: "remote-sync-selection-controls",
      attr: { "aria-label": "Filter" },
    });
    filterSection.createEl("h3", { text: "Filter" });
    const filterPicker = new Setting(
      filterSection.createDiv({ cls: "remote-sync-filter-picker" }),
    );
    filterPicker.addDropdown((d) => {
      d.selectEl.setAttribute("aria-label", "Filter file status");
      d.addOption("all", "All differences");
      for (const c of [
        "addition",
        "modification",
        "deletion",
        "rename",
        "conflict",
        "equal",
        "blocked",
      ])
        d.addOption(c, CATEGORIES[c as Category]);
      d.setValue(this.filter)
        .setDisabled(this.applying || !ready)
        .onChange((v) => {
          this.filter = v as Category | "all";
          this.render();
        });
    });
    const visible = changes.filter((c) =>
      this.filter === "all"
        ? c.classification !== "Synchronized"
        : this.filter === "conflict"
          ? c.category === "conflict" ||
            (c.category === "rename" &&
              (c.classification === "Conflicting paths" ||
                !equal(c.local, c.remote)))
          : c.category === this.filter,
    );
    const selectionButtons = new Setting(
      filterSection.createDiv({ cls: "remote-sync-selection-buttons" }),
    );
    selectionButtons.addButton((b) =>
      b
        .setButtonText("Select All")
        .setDisabled(this.applying || !ready)
        .onClick(() => {
          this.batchProgress = null;
          for (const c of visible)
            if (c.category !== "blocked" && !this.consumed.has(c.key))
              this.selectedActions.set(
                c.key,
                this.choices.get(c.key) ?? c.suggested,
              );
          this.render();
        }),
    );
    selectionButtons.addButton((b) =>
      b
        .setButtonText("Deselect All")
        .setDisabled(this.applying || !ready)
        .onClick(() => {
          this.batchProgress = null;
          this.selectedActions.clear();
          this.render();
        }),
    );
    const controls = new Setting(
      toolbarSection.createDiv({ cls: "remote-sync-review-tools" }),
    );
    controls.addButton((b) => {
      b.setButtonText("Scan")
        .setDisabled(this.applying || this.scanning)
        .onClick(() => {
          this.plugin.run(async () => {
            await this.loadReview();
          });
        });
      b.buttonEl.addClass("remote-sync-icon-button");
      b.buttonEl.addClass("remote-sync-scan-button");
      setIcon(
        b.buttonEl.createEl("span", {
          cls: "remote-sync-button-icon",
          attr: { "aria-hidden": "true" },
        }),
        "refresh-cw",
      );
    });
    controls.addButton((b) => {
      b.setButtonText("History").onClick(() =>
        new HistoryModal(this.app, this.plugin.state, "", context).open(),
      );
      b.buttonEl.addClass("remote-sync-icon-button");
      setIcon(
        b.buttonEl.createEl("span", {
          cls: "remote-sync-button-icon",
          attr: { "aria-hidden": "true" },
        }),
        "history",
      );
    });
    const badges = el.createDiv({ cls: "remote-sync-counts" });
    for (const [category, count] of counts)
      badges.createEl("span", {
        text: `${count} ${CATEGORIES[category]}`,
        cls: `remote-sync-badge remote-sync-tone-${category}`,
      });
    if (!ready)
      badges.createEl("span", {
        text: this.scanError ? "Status unavailable" : "Checking status…",
        cls: "remote-sync-status-pending",
      });
    const warnings = el.createDiv({ cls: "remote-sync-warnings" });
    if (ready) {
      for (const warning of [
        ...review!.local.warnings,
        ...review!.remote.warnings,
      ])
        warnings.createEl("p", { text: warning, cls: "remote-sync-warning" });
      const latestCommit = syncCommits(
        this.plugin.state.state.operations,
        this.plugin.state.state.journal,
      ).find((commit) => commit.context === context);
      const needsReview = latestCommit
        ? new Set([
            ...latestCommit.unresolved,
            ...latestCommit.operations
              .filter((operation) =>
                ["Running", "Failed", "Needs Rescan", "Cancelled"].includes(
                  operation.status,
                ),
              )
              .map((operation) => operation.id),
          ]).size
        : 0;
      if (needsReview)
        warnings.createEl("p", {
          text: `${needsReview} operation${needsReview === 1 ? "" : "s"} in the latest sync need review. Inspect history and both sides; no operation is resumed automatically.`,
          cls: "remote-sync-warning",
        });
    }
    const files = el.createDiv({ cls: "remote-sync-files" });
    files.setAttribute(
      "aria-busy",
      String(this.scanning || (!review && !this.scanError)),
    );
    if (!ready)
      this.renderScanState(
        files,
        !!review && !this.scanning && !this.scanError,
      );
    else if (!visible.length) {
      const synchronized =
        this.filter === "all" &&
        changes.every((c) => c.classification === "Synchronized");
      const empty = files.createDiv({ cls: "remote-sync-empty" });
      empty.createEl("strong", {
        text: synchronized
          ? "Everything is up to date"
          : "No files match this filter",
      });
      empty.createEl("p", {
        text: synchronized
          ? "Your files match. Choose “In sync” above to inspect them."
          : "Choose another filter to see other changes.",
      });
    }
    const groups = new Map<string, typeof visible>();
    for (const change of visible) {
      const folder = change.path.includes("/")
        ? change.path.slice(0, change.path.lastIndexOf("/"))
        : "";
      const key = JSON.stringify([
        folder,
        change.classification,
        change.actions,
      ]);
      const members = groups.get(key) ?? [];
      members.push(change);
      groups.set(key, members);
    }
    for (const [key, members] of groups) {
      const folder = members[0]!.path.includes("/")
        ? members[0]!.path.slice(0, members[0]!.path.lastIndexOf("/"))
        : "";
      const eligible = members.filter(
        (c) => c.category !== "blocked" && !this.consumed.has(c.key),
      );
      const commonActions = members[0]!.actions.filter((action) =>
        members.every((c) => c.actions.includes(action)),
      );
      const sharedDefault = members.every(
        (c) => c.suggested === members[0]!.suggested,
      )
        ? members[0]!.suggested
        : commonActions.includes("skip")
          ? "skip"
          : commonActions[0]!;
      for (const c of eligible)
        if (!this.choices.has(c.key)) this.choices.set(c.key, sharedDefault);
      const category = members[0]!.category;
      const group = files.createDiv({
        cls: `remote-sync-group remote-sync-tone-${category}`,
      });
      const disclosure = group.createEl("details", {
        cls: "remote-sync-group-disclosure",
      });
      disclosure.open = this.expandedGroups.has(key);
      disclosure.addEventListener("toggle", () => {
        if (disclosure.open) this.expandedGroups.add(key);
        else this.expandedGroups.delete(key);
      });
      const summary = disclosure.createEl("summary", {
        cls: "remote-sync-group-heading",
      });
      setIcon(
        summary.createEl("span", {
          cls: "remote-sync-group-folder-icon",
          attr: { "aria-hidden": "true" },
        }),
        "folder",
      );
      summary.createEl("strong", {
        text: folder ? `/${folder}/` : "/",
        cls: "remote-sync-group-path",
      });
      summary.createEl("span", {
        text: `${members.length} ${members.length === 1 ? "file" : "files"}`,
        cls: "remote-sync-badge remote-sync-tone-neutral remote-sync-group-count",
      });
      summary.createEl("span", {
        text: members[0]!.classification,
        cls: `remote-sync-badge remote-sync-tone-${category}`,
      });
      const controls = new Setting(
        group.createDiv({ cls: "remote-sync-group-controls" }),
      );
      controls.addButton((button) =>
        button
          .setButtonText("Select group")
          .setDisabled(this.applying || !eligible.length)
          .onClick(() => {
            this.batchProgress = null;
            for (const c of eligible)
              this.selectedActions.set(
                c.key,
                this.choices.get(c.key) ?? sharedDefault,
              );
            this.render();
          }),
      );
      controls.addButton((button) =>
        button
          .setButtonText("Deselect group")
          .setDisabled(this.applying || !eligible.length)
          .onClick(() => {
            this.batchProgress = null;
            for (const c of eligible) this.selectedActions.delete(c.key);
            this.render();
          }),
      );
      controls.addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute(
          "aria-label",
          `Action for ${folder || "Root"} ${members[0]!.classification}`,
        );
        const choices = new Set(
          eligible.map((c) => this.choices.get(c.key) ?? sharedDefault),
        );
        if (choices.size > 1) dropdown.addOption("mixed", "Mixed actions");
        for (const action of commonActions)
          dropdown.addOption(action, LABELS[action]);
        dropdown
          .setValue(
            choices.size > 1 ? "mixed" : ([...choices][0] ?? sharedDefault),
          )
          .setDisabled(this.applying || !eligible.length)
          .onChange((value) => {
            if (value === "mixed") return;
            for (const c of eligible) {
              this.choices.set(c.key, value as Action);
              if (this.selectedActions.has(c.key))
                this.selectedActions.set(c.key, value as Action);
            }
            this.render();
          });
      });
      const groupFiles = disclosure.createDiv({
        cls: "remote-sync-group-files",
      });
      for (const c of members) {
        const card = groupFiles.createDiv({ cls: "remote-sync-file" });
        card.setAttribute("data-category", c.category);
        const heading = card.createDiv({ cls: "remote-sync-file-heading" });
        const checkbox = heading.createEl("input", {
          type: "checkbox",
          cls: "remote-sync-file-checkbox",
          attr: { "aria-label": `Select ${c.path}` },
        });
        const info = heading.createDiv({ cls: "remote-sync-file-info" });
        const name = info.createDiv({ cls: "remote-sync-file-name" });
        name.createEl("strong", { text: c.path.split("/").pop() ?? c.path });
        name.createEl("span", {
          text: c.classification,
          cls: `remote-sync-badge remote-sync-tone-${c.category}`,
        });
        const folder = c.path.includes("/")
          ? c.path.slice(0, c.path.lastIndexOf("/"))
          : "";
        if (c.localPath !== c.remotePath)
          info.createEl("div", {
            text: `Local: ${c.localPath} · Remote: ${c.remotePath}`,
            cls: "remote-sync-file-path",
          });
        else if (folder)
          info.createEl("div", { text: folder, cls: "remote-sync-file-path" });
        const setting = new Setting(
          heading.createDiv({ cls: "remote-sync-file-actions" }),
        );
        checkbox.checked = this.selectedActions.has(c.key);
        checkbox.disabled =
          this.applying || c.category === "blocked" || this.consumed.has(c.key);
        checkbox.addEventListener("change", () => {
          this.batchProgress = null;
          if (checkbox.checked)
            this.selectedActions.set(
              c.key,
              this.choices.get(c.key) ?? c.suggested,
            );
          else this.selectedActions.delete(c.key);
          this.render();
        });
        const risk = card.createEl("p", { cls: "remote-sync-file-risk" });
        risk.textContent = actionWarning(
          this.choices.get(c.key) ?? c.suggested,
        );
        risk.hidden = !risk.textContent;
        setting.addDropdown((d) => {
          for (const action of c.actions) d.addOption(action, LABELS[action]);
          d.setValue(this.choices.get(c.key) ?? c.suggested)
            .setDisabled(this.applying || this.consumed.has(c.key))
            .onChange((v) => {
              this.choices.set(c.key, v as Action);
              if (this.selectedActions.has(c.key))
                this.selectedActions.set(c.key, v as Action);
              risk.textContent = actionWarning(v as Action);
              risk.hidden = !risk.textContent;
              this.render();
            });
        });
        const details = card.createEl("details", {
          cls: "remote-sync-file-details",
        });
        details.open = this.expandedFiles.has(c.key);
        details.addEventListener("toggle", () => {
          if (details.open) this.expandedFiles.add(c.key);
          else this.expandedFiles.delete(c.key);
        });
        details.createEl("summary", { text: "Why is this file listed?" });
        details.createEl("p", {
          text: c.explanation,
        });
        const detailMetadata = details.createDiv({
          cls: "remote-sync-detail-metadata",
        });
        metadata(detailMetadata, "Suggested action", LABELS[c.suggested]);
        metadata(
          detailMetadata,
          "Local",
          `${size(c.local?.size)} · ${stamp(c.local?.modifiedAt)}`,
        );
        metadata(
          detailMetadata,
          "Remote",
          `${size(c.remote?.size)} · ${stamp(c.remote?.modifiedAt)}`,
        );
        metadata(
          detailMetadata,
          "Last synchronized",
          stamp(c.baseline?.syncedAt),
        );
        const observed = this.plugin.state.state.seen[context]?.[c.key];
        metadata(
          detailMetadata,
          "First observed",
          stamp(observed?.firstSeenAt),
        );
        metadata(detailMetadata, "Last observed", stamp(observed?.lastSeenAt));
        const technical = details.createEl("details", {
          cls: "remote-sync-technical",
        });
        technical.createEl("summary", { text: "Hashes and technical details" });
        technical.createEl("p", {
          text: "Timestamps are hints. Content hashes and confirmed state determine the classification.",
        });
        technical.createEl("pre", {
          text: JSON.stringify(
            { baseline: c.baseline, local: c.local, remote: c.remote },
            null,
            2,
          ),
        });
        new Setting(details).addButton((b) =>
          b
            .setButtonText("Per-file history")
            .onClick(() =>
              new HistoryModal(
                this.app,
                this.plugin.state,
                c.path,
                context,
              ).open(),
            ),
        );
        if (this.consumed.has(c.key))
          card.createEl("p", {
            text: "Reviewed. Scan again to review this path.",
          });
      }
    }
    const footer = el.createDiv({ cls: "remote-sync-review-footer" });
    this.progressStatusEl = footer.createEl("p", {
      text: `Selected operations: ${this.selectedActions.size}`,
      cls: "remote-sync-progress-status",
      attr: { role: "status", "aria-live": "polite" },
    });
    this.progressTrackEl = footer.createEl("progress", {
      cls: "remote-sync-progress",
      attr: { "aria-label": "File operations completed" },
    });
    this.progressFileEl = footer.createEl("div", {
      cls: "remote-sync-progress-file",
    });
    this.fileTransferEl = footer.createDiv({
      cls: "remote-sync-file-transfer",
    });
    this.updateProgress();
    this.updateFileTransfer();
    new Setting(footer)
      .addButton((b) =>
        b
          .setButtonText(this.applying ? "Cancel Transfers" : "Close")
          .onClick(() => {
            if (this.applying) this.plugin.executor?.cancel();
            else this.close();
          }),
      )
      .addButton((b) =>
        b
          .setButtonText("Apply Selected")
          .setCta()
          .setDisabled(this.applying || !ready || !this.selectedActions.size)
          .onClick(() => {
            this.plugin.run(async () => {
              if (this.applying) return;
              this.applying = true;
              this.batchProgress = null;
              this.render();
              try {
                if (
                  !review ||
                  !ready ||
                  this.scanning ||
                  this.scanError ||
                  !this.plugin.credentials.unlocked ||
                  !this.plugin.executor ||
                  this.plugin.context() !== review.context ||
                  (review.selectionVersion !== undefined &&
                    review.selectionVersion !== this.plugin.selectionVersion)
                )
                  throw new Error(
                    "Credentials locked or configuration changed. Scan before applying.",
                  );
                const selected = review.changes
                  .filter((c) => this.selectedActions.has(c.key))
                  .map((change) => ({
                    change,
                    action: this.selectedActions.get(change.key)!,
                  }));
                const destructive = selected.filter(
                  (s) =>
                    s.action.startsWith("trash") || s.action.startsWith("use-"),
                ).length;
                if (
                  !(await confirm(
                    this.app,
                    "Confirm changes",
                    (container) => {
                      container.createEl("p", {
                        text: `Remote: ${review.remoteName ?? this.plugin.credentials.credentials.folderName}`,
                        cls: "remote-sync-summary-intro",
                      });
                      renderOperationSummary(container, selected);
                    },
                    destructive > 0,
                  ))
                )
                  return;
                const needsMass = massDeletion(
                  selected,
                  this.plugin.state.state.baselines[review.context] ?? {},
                  review,
                );
                if (
                  needsMass &&
                  !(await confirm(
                    this.app,
                    "Mass deletion protection",
                    "More than 25% of the previously synchronized files in this batch will be trashed. Confirm this additional deletion safeguard.",
                    true,
                  ))
                )
                  return;
                this.batchProgress = {
                  total: selected.length,
                  completed: 0,
                  success: 0,
                  failed: 0,
                  rescan: 0,
                  skipped: 0,
                  cancelled: 0,
                  path: "Preparing selected files…",
                  phase: "running",
                };
                this.updateProgress();
                const result = await this.plugin.executor!.apply(
                  review,
                  selected,
                  true,
                  needsMass,
                  (op, n, total) => {
                    const progress = this.batchProgress!;
                    progress.completed = n;
                    progress.total = total;
                    progress.path = `${op.path} · ${op.status}`;
                    if (op.status === "Success") progress.success++;
                    if (op.status === "Failed") progress.failed++;
                    if (op.status === "Needs Rescan") progress.rescan++;
                    if (op.status === "Skipped") progress.skipped++;
                    this.updateProgress();
                  },
                  (transfer) => {
                    this.fileTransfers = transfer;
                    this.updateFileTransfer();
                  },
                );
                for (const op of result)
                  if (op.status !== "Cancelled") {
                    const c = selected.find((s) => s.change.path === op.path);
                    if (c) {
                      this.consumed.add(c.change.key);
                      this.selectedActions.delete(c.change.key);
                    }
                  }
                const progress = this.batchProgress;
                progress.completed = result.filter(
                  (o) => o.status !== "Cancelled",
                ).length;
                progress.success = result.filter(
                  (o) => o.status === "Success",
                ).length;
                progress.failed = result.filter(
                  (o) => o.status === "Failed",
                ).length;
                progress.rescan = result.filter(
                  (o) => o.status === "Needs Rescan",
                ).length;
                progress.skipped = result.filter(
                  (o) => o.status === "Skipped",
                ).length;
                progress.cancelled = result.filter(
                  (o) => o.status === "Cancelled",
                ).length;
                progress.phase = progress.cancelled ? "stopped" : "complete";
                notifySyncResult(
                  `${progress.success} succeeded · ${progress.failed} failed · ${progress.rescan} need rescan${progress.skipped ? ` · ${progress.skipped} skipped` : ""}${progress.cancelled ? ` · ${progress.cancelled} cancelled` : ""}. See History for details.`,
                  progress.failed
                    ? "error"
                    : progress.rescan || progress.cancelled || progress.skipped
                      ? "warning"
                      : "success",
                );
              } catch (error) {
                if (this.batchProgress) this.batchProgress.phase = "failed";
                throw error;
              } finally {
                this.applying = false;
                this.fileTransfers = [];
                if (!this.closed) this.render();
              }
            });
          }),
      );
    // Restore only after the rows and footer have their final layout. Rebuilding
    // the list after a selection otherwise resets its independent scroll area.
    files.scrollTop = fileScrollTop;
  }
  /** Open the window before awaiting credentials, filesystem work or Google. */
  async loadReview(): Promise<void> {
    if (this.scanning || this.applying || this.closed) return;
    this.scanning = true;
    this.scanError = null;
    this.selectedActions.clear();
    this.batchProgress = null;
    this.fileTransfers = [];
    this.render();
    try {
      // Allow the loading view to paint before any synchronous hashing begins.
      await new Promise<void>((resolve) => {
        const win = this.contentEl.ownerDocument.defaultView;
        if (win?.requestAnimationFrame)
          win.requestAnimationFrame(() =>
            win.requestAnimationFrame(() => resolve()),
          );
        else setTimeout(resolve, 0);
      });
      if (this.closed) return;
      const review = await this.plugin.scan((message) => {
        if (!this.closed && this.scanStatusEl)
          this.scanStatusEl.textContent = message;
      });
      if (this.closed) return;
      this.review = review;
      this.selectedActions.clear();
      this.consumed.clear();
      this.choices.clear();
      this.expandedFiles.clear();
      this.batchProgress = null;
    } catch (error) {
      this.scanError =
        error instanceof Error
          ? error.message
          : "The scan could not be completed.";
      throw error;
    } finally {
      this.scanning = false;
      if (!this.closed) this.render();
    }
  }
  private renderScanState(parent: HTMLElement, needsUnlock = false): void {
    const error =
      this.scanError ??
      (needsUnlock
        ? "Credentials locked or configuration changed. Scan to refresh status."
        : null);
    const area = parent.createDiv({
      cls: "remote-sync-empty remote-sync-scan-state",
    });
    area.setAttribute("aria-busy", String(!error));
    area.createEl("strong", {
      text: error ? "Could not load file status" : "Checking your files",
    });
    this.scanStatusEl = area.createEl("p", {
      text: error ?? "Preparing the local and Google Drive comparison…",
      attr: { role: "status", "aria-live": "polite" },
    });
    if (!error)
      area.createDiv({ cls: "remote-sync-scan-track" }).createEl("progress", {
        cls: "remote-sync-scan-progress",
        attr: { "aria-label": "Loading file status" },
      });
    if (error)
      new Setting(area).addButton((button) =>
        button
          .setButtonText("Retry")
          .setCta()
          .onClick(() => this.plugin.run(() => this.loadReview())),
      );
  }
  private updateFileTransfer(): void {
    const container = this.fileTransferEl;
    if (!container || this.closed) return;
    container.hidden = this.fileTransfers.length === 0;
    if (this.progressFileEl)
      this.progressFileEl.hidden =
        this.fileTransfers.length > 0 || !this.batchProgress;
    container.empty();
    for (const transfer of this.fileTransfers) {
      const row = container.createDiv({ cls: "remote-sync-transfer-row" });
      const percent = transfer.total
        ? Math.min(
            100,
            Math.floor((transfer.transferred / transfer.total) * 100),
          )
        : 0;
      const phase =
        transfer.phase === "preparing"
          ? "Preparing"
          : transfer.phase === "verifying"
            ? "Verifying"
            : transfer.direction === "upload"
              ? "Uploading"
              : "Downloading";
      row.createEl("div", {
        cls: "remote-sync-file-transfer-label",
        text: `${phase} · ${transfer.path} · ${size(transfer.transferred)} / ${size(transfer.total)}${transfer.phase === "transferring" && transfer.total ? ` · ${percent}%` : ""}`,
      });
      const bar = row.createEl("progress", {
        cls: "remote-sync-progress remote-sync-file-transfer-progress",
        attr: {
          "aria-label": `${transfer.direction === "upload" ? "Upload" : "Download"} bytes transferred: ${transfer.path}`,
        },
      });
      bar.max = Math.max(1, transfer.total);
      bar.value = Math.min(transfer.transferred, transfer.total);
    }
  }
  private updateProgress(): void {
    const progress = this.batchProgress;
    if (this.progressTrackEl) this.progressTrackEl.hidden = !progress;
    if (this.progressFileEl) this.progressFileEl.hidden = !progress;
    if (!progress) return;
    const outcomes = [
      `${progress.success} succeeded`,
      ...(progress.failed ? [`${progress.failed} failed`] : []),
      ...(progress.rescan ? [`${progress.rescan} need rescan`] : []),
      ...(progress.skipped ? [`${progress.skipped} skipped`] : []),
      ...(progress.cancelled ? [`${progress.cancelled} cancelled`] : []),
    ].join(" · ");
    if (this.progressStatusEl)
      this.progressStatusEl.textContent = `${progress.completed}/${progress.total} completed · ${outcomes}`;
    if (this.progressFileEl)
      this.progressFileEl.textContent =
        progress.phase === "running"
          ? progress.path
          : progress.phase === "failed"
            ? "Stopped after an error. Inspect History and refresh the scan."
            : progress.phase === "stopped"
              ? "Cancelled. Unstarted files remain pending."
              : "Finished. Scan again to review the remaining changes.";
    if (this.progressTrackEl) {
      this.progressTrackEl.max = progress.total;
      this.progressTrackEl.value = progress.completed;
      this.progressTrackEl.setAttribute(
        "data-tone",
        progress.failed || progress.phase === "failed"
          ? "error"
          : progress.rescan || progress.cancelled || progress.skipped
            ? "warning"
            : progress.phase === "complete"
              ? "success"
              : "info",
      );
    }
  }
}
