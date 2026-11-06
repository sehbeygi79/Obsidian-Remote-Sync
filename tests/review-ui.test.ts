import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type RemoteSyncPlugin from "../src/main";
import type { SyncExecutor } from "../src/sync/SyncExecutor";
import { SyncReviewModal } from "../src/ui/SyncReviewModal";
import { reconcile } from "../src/sync/ReconciliationEngine";
import { file, memoryStore, snapshot } from "./helpers";
import { Modal, UiElement } from "./ui-host";
import { dismissNotifications } from "../src/ui/Notifications";
import type { Operation, Review } from "../src/sync/types";

function fixture(loaded = true) {
  const local = snapshot(
    Array.from({ length: 28 }, (_, i) => file(`images/${i}.jpg`)),
  );
  const remote = snapshot();
  const review = {
    local,
    remote,
    changes: reconcile(local, remote, {}),
    context: "test",
  };
  const state = memoryStore();
  const apply = vi.fn<SyncExecutor["apply"]>(async () => []);
  let pending = Promise.resolve();
  const plugin = {
    credentials: { unlocked: true, credentials: { folderName: "Test" } },
    state,
    context: () => "test",
    executor: { apply, cancel: vi.fn() },
    scan: vi.fn<RemoteSyncPlugin["scan"]>(async () => review),
    run: (task: () => Promise<void>) => {
      pending = task();
    },
  };
  const modal = new SyncReviewModal(
    {} as App,
    plugin as unknown as RemoteSyncPlugin,
    loaded ? review : undefined,
  );
  const content = modal.contentEl as unknown as UiElement;
  const button = (text: string, root = content) => {
    const found = root.all(
      (el) => el.tag === "button" && el.textContent === text,
    )[0];
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  };
  const checkboxes = () =>
    content.all((el) => el.attributes.type === "checkbox");
  const status = () => content.querySelector('[role="status"]')!.textContent;
  return {
    modal,
    content,
    button,
    checkboxes,
    status,
    plugin,
    apply,
    review,
    done: () => pending,
  };
}

describe("sync review modal", () => {
  afterEach(() => dismissNotifications());
  beforeEach(() => {
    Modal.opened = [];
  });

  it("renders all 28 additions and Apply after the host captures editor selection", () => {
    const f = fixture();
    expect(() => f.modal.open()).not.toThrow();
    expect(
      f.content.all((el) => el.classes.has("remote-sync-file")),
    ).toHaveLength(28);
    expect(f.checkboxes()).toHaveLength(28);
    expect(f.checkboxes().every((el) => !el.checked)).toBe(true);
    expect(f.button("Apply Selected").disabled).toBe(true);
    expect(f.status()).toBe("Selected operations: 0");
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("separates file selection from scan and history controls", () => {
    const f = fixture();
    f.modal.open();
    const selection = f.content.querySelector(
      ".remote-sync-selection-controls",
    )!;
    const tools = f.content.querySelector(".remote-sync-review-tools")!;
    expect(selection.tag).toBe("section");
    expect(selection.querySelector("h3")!.textContent).toBe("Filter");
    expect(
      f.content.children.indexOf(
        f.content.querySelector(".remote-sync-counts")!,
      ),
    ).toBeGreaterThan(
      f.content.children.indexOf(
        f.content.querySelector(".remote-sync-toolbar")!,
      ),
    );
    expect(
      selection.all((el) => el.tag === "button").map((el) => el.textContent),
    ).toEqual(["Select All", "Deselect All"]);
    expect(
      tools.all((el) => el.tag === "button").map((el) => el.textContent),
    ).toEqual(["Scan", "History"]);
    expect(f.content.querySelector("h2")!.textContent).toBe("Review Status");
  });

  it("opens immediately with an indeterminate bar, then shows the completed review", async () => {
    const f = fixture(false);
    let finish!: (review: Review) => void;
    const pending = new Promise<Review>((resolve) => {
      finish = resolve;
    });
    f.plugin.scan.mockImplementation(async (onStatus) => {
      onStatus?.("Checking Google Drive…");
      return pending;
    });
    f.modal.open();
    expect(Modal.opened).toContain(f.modal);
    expect(
      f.content.querySelector("progress")!.attributes.value,
    ).toBeUndefined();
    expect(f.checkboxes()).toHaveLength(0);
    expect(f.content.querySelector(".remote-sync-locations")).not.toBeNull();
    expect(f.content.querySelector(".remote-sync-toolbar")).not.toBeNull();
    expect(
      f.content.querySelector(".remote-sync-review-footer"),
    ).not.toBeNull();
    expect(
      f.content.querySelector(".remote-sync-scan-state")!.parentElement,
    ).toBe(f.content.querySelector(".remote-sync-files"));
    expect(f.plugin.scan).not.toHaveBeenCalled();
    const loading = f.modal.loadReview();
    await vi.waitFor(() => expect(f.plugin.scan).toHaveBeenCalledOnce());
    expect(f.status()).toBe("Checking Google Drive…");
    expect(
      f.content.querySelector(".remote-sync-scan-state")!.attributes[
        "aria-busy"
      ],
    ).toBe("true");
    expect(f.apply).not.toHaveBeenCalled();
    finish(f.review);
    await loading;
    expect(f.checkboxes()).toHaveLength(28);
    expect(f.content.querySelector(".remote-sync-scan-state")).toBeNull();
  });

  it("shows a failed scan with retry instead of leaving an empty or stale review", async () => {
    const f = fixture(false);
    f.plugin.scan.mockRejectedValueOnce(new Error("Network unavailable"));
    f.modal.open();
    await expect(f.modal.loadReview()).rejects.toThrow("Network unavailable");
    expect(f.status()).toBe("Network unavailable");
    expect(f.content.querySelector(".remote-sync-scan-progress")).toBeNull();
    expect(f.checkboxes()).toHaveLength(0);
    f.button("Retry").listeners.click!();
    await f.done();
    expect(f.checkboxes()).toHaveLength(28);
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("does not reopen or render a review that was closed during scanning", async () => {
    const f = fixture(false);
    let finish!: (review: Review) => void;
    f.plugin.scan.mockReturnValue(
      new Promise<Review>((resolve) => {
        finish = resolve;
      }),
    );
    f.modal.open();
    const loading = f.modal.loadReview();
    await vi.waitFor(() => expect(f.plugin.scan).toHaveBeenCalledOnce());
    f.modal.close();
    finish(f.review);
    await loading;
    expect(f.content.children).toHaveLength(0);
    expect(Modal.opened).not.toContain(f.modal);
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("separates the folder metadata and keeps file evidence collapsed", () => {
    const f = fixture();
    f.modal.open();
    const locations = f.content.querySelector(".remote-sync-locations")!;
    expect(locations.children).toHaveLength(3);
    expect(
      locations.all((el) => el.textContent === "Last confirmed sync"),
    ).toHaveLength(1);
    expect(
      f.content.all((el) => /Last scan:/i.test(el.textContent)),
    ).toHaveLength(0);
    const card = f.content.querySelector(".remote-sync-file")!;
    expect(card.querySelector("strong")!.textContent).toBe("0.jpg");
    const details = card.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe(
      "Why is this file listed?",
    );
    expect(
      details.all((el) =>
        el.textContent.includes(f.review.changes[0]!.explanation),
      ),
    ).toHaveLength(1);
    expect(
      card.children.filter((el) =>
        el.textContent.includes(f.review.changes[0]!.explanation),
      ),
    ).toHaveLength(0);
  });

  it("keeps file selections across rerenders and clears them on deselect or refresh", async () => {
    const f = fixture();
    f.modal.open();
    const first = f.checkboxes()[0]!;
    first.checked = true;
    first.listeners.change!();
    expect(f.status()).toBe("Selected operations: 1");
    expect(f.checkboxes()[0]!.checked).toBe(true);
    expect(f.button("Apply Selected").disabled).toBe(false);
    f.button("Select All").listeners.click!();
    expect(f.checkboxes().every((el) => el.checked)).toBe(true);
    expect(f.status()).toBe("Selected operations: 28");
    f.button("Deselect All").listeners.click!();
    expect(f.status()).toBe("Selected operations: 0");
    f.button("Select All").listeners.click!();
    f.button("Scan").listeners.click!();
    await f.done();
    expect(f.plugin.scan).toHaveBeenCalledOnce();
    expect(f.checkboxes().every((el) => !el.checked)).toBe(true);
    expect(f.button("Apply Selected").disabled).toBe(true);
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("requires confirmation and submits only the chosen file and action", async () => {
    const f = fixture();
    f.modal.open();
    const first = f.checkboxes()[0]!;
    first.checked = true;
    first.listeners.change!();
    f.button("Apply Selected").listeners.click!();
    expect(f.apply).not.toHaveBeenCalled();
    const confirmation = Modal.opened.at(-1)!;
    const uploads = confirmation.contentEl.querySelector(
      ".remote-sync-summary-uploads",
    )!;
    expect(uploads.querySelector("h3")!.textContent).toBe("Uploads");
    expect(
      uploads
        .querySelector(".remote-sync-summary-add")!
        .querySelector("strong")!.textContent,
    ).toBe("1");
    f.button("Confirm", confirmation.contentEl).listeners.click!();
    await f.done();
    expect(f.apply).toHaveBeenCalledOnce();
    const selected = f.apply.mock.calls[0]![1];
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      action: "upload",
      change: { path: "images/0.jpg" },
    });
  });

  it("shows file progress beneath the status and retains the completed summary", async () => {
    const f = fixture();
    f.apply.mockImplementation(
      async (_review, selected, _confirmed, _mass, onProgress) => {
        const results: Operation[] = selected.map(({ change, action }, i) => ({
          id: String(i),
          session: "test",
          at: 1,
          context: "test",
          path: change.path,
          action,
          status: i === 20 ? "Failed" : "Success",
          before: { local: change.local, remote: change.remote },
        }));
        for (const [i, op] of results.entries()) {
          onProgress!(op, i + 1, selected.length);
          if (i === 19) {
            expect(f.status()).toBe("20/28 completed · 20 succeeded");
            const bar = f.content.querySelector("progress")!;
            expect(bar.hidden).toBe(false);
            expect(bar.value).toBe(20);
            expect(bar.max).toBe(28);
            expect(
              f.content.querySelector(".remote-sync-review-footer")!
                .children[1],
            ).toBe(bar);
          }
        }
        return results;
      },
    );
    f.modal.open();
    f.button("Select All").listeners.click!();
    f.button("Apply Selected").listeners.click!();
    f.button("Confirm", Modal.opened.at(-1)!.contentEl).listeners.click!();
    await f.done();
    expect(f.status()).toBe("28/28 completed · 27 succeeded · 1 failed");
    expect(f.content.querySelector("progress")!.attributes["data-tone"]).toBe(
      "error",
    );
  });

  it("does not report unstarted cancelled files as completed", async () => {
    const f = fixture();
    f.apply.mockImplementation(async (_review, selected) =>
      selected.map(({ change, action }, i) => ({
        id: String(i),
        session: "test",
        at: 1,
        context: "test",
        path: change.path,
        action,
        status: i < 2 ? "Success" : "Cancelled",
        before: { local: change.local, remote: change.remote },
      })),
    );
    f.modal.open();
    f.button("Select All").listeners.click!();
    f.button("Apply Selected").listeners.click!();
    f.button("Confirm", Modal.opened.at(-1)!.contentEl).listeners.click!();
    await f.done();
    expect(f.status()).toBe("2/28 completed · 2 succeeded · 26 cancelled");
    expect(f.content.querySelector("progress")!.value).toBe(2);
    expect(f.content.querySelector("progress")!.attributes["data-tone"]).toBe(
      "warning",
    );
    expect(f.checkboxes().filter((el) => el.checked)).toHaveLength(26);
  });

  it("shows current-file bytes separately and waits for verification before counting success", async () => {
    const f = fixture();
    f.apply.mockImplementation(
      async (_review, selected, _confirmed, _mass, onProgress, onTransfer) => {
        const path = selected[0]!.change.path,
          total = 64 * 1024 * 1024;
        onTransfer!({
          path,
          direction: "upload",
          transferred: 16 * 1024 * 1024,
          total,
          phase: "transferring",
        });
        const bar = f.content.querySelector(
          ".remote-sync-file-transfer-progress",
        )!;
        expect(
          f.content.querySelector(".remote-sync-file-transfer")!.hidden,
        ).toBe(false);
        expect(bar.value).toBe(16 * 1024 * 1024);
        expect(bar.max).toBe(total);
        expect(
          f.content.querySelector(".remote-sync-file-transfer-label")!
            .textContent,
        ).toContain("16.00 MiB / 64.00 MiB · 25%");
        expect(f.status()).toBe("0/1 completed · 0 succeeded");
        onTransfer!({
          path,
          direction: "upload",
          transferred: total,
          total,
          phase: "verifying",
        });
        expect(
          f.content.querySelector(".remote-sync-file-transfer-label")!
            .textContent,
        ).toContain("Verifying");
        expect(f.status()).toBe("0/1 completed · 0 succeeded");
        const op: Operation = {
          id: "test",
          session: "test",
          at: 1,
          context: "test",
          path,
          action: "upload",
          status: "Success",
          before: { local: selected[0]!.change.local, remote: null },
        };
        onTransfer!(null);
        onProgress!(op, 1, 1);
        return [op];
      },
    );
    f.modal.open();
    const first = f.checkboxes()[0]!;
    first.checked = true;
    first.listeners.change!();
    f.button("Apply Selected").listeners.click!();
    f.button("Confirm", Modal.opened.at(-1)!.contentEl).listeners.click!();
    await f.done();
    expect(f.status()).toBe("1/1 completed · 1 succeeded");
    expect(f.content.querySelector(".remote-sync-file-transfer")!.hidden).toBe(
      true,
    );
  });
});

it("switches remote profiles through a fresh scan and clears the previous file selection", async () => {
  const f = fixture();
  const profiles = [
    { id: "first", name: "First remote", accountRef: "one" },
    { id: "second", name: "Second remote", accountRef: "two" },
  ];
  let active = profiles[0]!;
  Object.assign(f.plugin.credentials, {
    remotes: profiles,
    account: (ref: string) => ({ accountEmail: `${ref}@example.test` }),
  });
  Object.defineProperty(f.plugin.credentials, "activeRemote", {
    get: () => active,
  });
  Object.assign(f.review, {
    profileId: "first",
    remoteName: "First remote",
    selectionVersion: 0,
  });
  const selectRemote = vi.fn(async (id: string) => {
    active = profiles.find((p) => p.id === id)!;
    extended.selectionVersion++;
  });
  const extended = Object.assign(f.plugin, {
    selectionVersion: 0,
    selectRemote,
  });
  f.plugin.scan.mockImplementation(async () => ({
    ...f.review,
    profileId: active.id,
    remoteName: active.name,
    selectionVersion: extended.selectionVersion,
  }));
  f.modal.open();
  f.button("Select All").listeners.click!();
  const selector = f.content.all(
    (el) => el.attributes["aria-label"] === "Remote profile",
  )[0]!;
  expect(selector.tag).toBe("summary");
  const option = f.content.all(
    (el) => el.attributes["data-value"] === "second",
  )[0]!;
  option.listeners.click!();
  await f.done();
  expect(selectRemote).toHaveBeenCalledWith("second");
  expect(f.plugin.scan).toHaveBeenCalledOnce();
  expect(f.status()).toBe("Selected operations: 0");
  expect(f.apply).not.toHaveBeenCalled();
  f.button("Select All").listeners.click!();
  f.button("Apply Selected").listeners.click!();
  expect(
    f.content.all((el) => el.attributes["aria-label"] === "Remote profile")[0]!
      .attributes["aria-disabled"],
  ).toBe("true");
  Modal.opened.at(-1)!.contentEl.all((el) => el.textContent === "Cancel")[0]!
    .listeners.click!();
  await f.done();
  f.modal.close();
});
