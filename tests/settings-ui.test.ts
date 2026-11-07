import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type RemoteSyncPlugin from "../src/main";
import { RemoteSyncSettings } from "../src/ui/SettingsTab";
import type { Operation } from "../src/sync/types";
import { baseline, memoryStore } from "./helpers";
import { Modal, type UiElement } from "./ui-host";

function fixture(connected = true, saved = true) {
  const state = memoryStore();
  const save = vi.spyOn(state, "save").mockResolvedValue();
  const prune = vi.spyOn(state, "prune");
  const credentials = {
    unlocked: connected,
    envelope: saved ? {} : null,
    get credentials() {
      if (!this.unlocked) throw new Error("Credentials locked");
      return {
        accountEmail: "person@example.test",
        folderName: "Test remote",
        folderId: "test-folder",
      };
    },
    get accounts() {
      return [{ id: "account-one", credentials: this.credentials }];
    },
    remotes: [
      {
        id: "remote-one",
        name: "My remote",
        accountRef: "account-one",
        folderId: "test-folder",
        folderName: "Test remote",
      },
    ],
    get activeRemote() {
      return this.remotes[0];
    },
    configuration: { activeAccountId: "account-one" },
    account(_ref?: string) {
      return this.credentials;
    },
    disconnect: vi.fn(async () => {
      credentials.unlocked = false;
      credentials.envelope = null;
    }),
  };
  let working = false;
  const tasks: Promise<unknown>[] = [];
  const errors: unknown[] = [];
  const plugin = {
    state,
    credentials,
    localFolder: "materials",
    localFolders: ["materials"],
    saveIgnorePatterns: vi.fn(async (_value: string) => {}),
    manifest: { version: "1.2.0" },
    executor: {},
    lock: vi.fn(() => {
      if (working) throw new Error("Cannot lock during a task");
      credentials.unlocked = false;
    }),
    unlock: vi.fn(async () => {
      credentials.unlocked = true;
    }),
    tokenStatus: vi.fn(() => ({ needsReconnect: false })),
    drive: vi.fn(),
    manager: vi.fn(),
    context: () => "test",
    run: vi.fn((task: () => Promise<unknown>) => {
      working = true;
      tasks.push(
        task()
          .catch((error) => errors.push(error))
          .finally(() => {
            working = false;
          }),
      );
    }),
  };
  const tab = new RemoteSyncSettings(
    {} as App,
    plugin as unknown as RemoteSyncPlugin,
  );
  const root = tab.containerEl as unknown as UiElement;
  tab.display();
  const button = (caption: string) =>
    root.all((el) => el.tag === "button" && el.textContent === caption)[0]!;
  return {
    state,
    save,
    prune,
    credentials,
    plugin,
    tab,
    root,
    button,
    tasks,
    errors,
  };
}
const text = (element: UiElement) =>
  element
    .all(() => true)
    .map((el) => el.textContent)
    .join("\n");

describe("Remote Sync settings", () => {
  beforeEach(() => {
    Modal.opened = [];
  });
  it("edits ignore rules without saving until the user clicks Save", async () => {
    const f = fixture();
    const input = f.root.all((element) => element.tag === "textarea")[0]!;
    input.value = ".obsidian/\n*.tmp";
    expect(f.plugin.saveIgnorePatterns).not.toHaveBeenCalled();
    f.button("Save ignore list").listeners.click!();
    await Promise.all(f.tasks);
    expect(f.plugin.saveIgnorePatterns).toHaveBeenCalledWith(
      ".obsidian/\n*.tmp",
    );
    expect(f.errors).toEqual([]);
  });
  it("shows account and folder cards while keeping transfer and recovery tools collapsed", () => {
    const { root, plugin } = fixture();
    expect(text(root)).toContain("person@example.test");
    expect(text(root)).toContain("Test remote");
    const cards = root.all((el) => el.classes.has("remote-sync-settings-card"));
    expect(cards).toHaveLength(5);
    expect(
      cards
        .filter((el) => el.tag === "details")
        .map((el) => el.children[0]!.textContent),
    ).toEqual(["Credentials & device transfer", "Advanced & recovery"]);
    expect(
      cards.filter((el) => el.tag === "details").every((el) => !el.open),
    ).toBe(true);
    expect(plugin.drive).not.toHaveBeenCalled();
    expect(plugin.manager).not.toHaveBeenCalled();
    expect(plugin.run).not.toHaveBeenCalled();
  });
  it.each([
    [false, true],
    [false, false],
  ])(
    "renders locked/disconnected accounts without accessing decrypted credentials (%s,%s)",
    (connected, saved) => {
      const { root, button } = fixture(connected, saved);
      expect(text(root)).not.toContain("person@example.test");
      expect(text(root)).not.toContain("Test remote");
      expect(button(saved ? "Unlock" : "Connect on Ubuntu")).toBeDefined();
      expect(button("Export").disabled).toBe(!saved);
      expect(button("Change").disabled).toBe(!saved);
    },
  );
  it("locks directly instead of marking the plugin busy before locking", () => {
    const { button, plugin, root } = fixture();
    button("Lock").listeners.click!();
    expect(plugin.lock).toHaveBeenCalledOnce();
    expect(plugin.run).not.toHaveBeenCalled();
    expect(text(root)).toContain("Locked");
    expect(text(root)).not.toContain("person@example.test");
  });
  it("saves history retention only when Save is clicked and rejects invalid values", async () => {
    const { root, button, state, save, prune, tasks, errors } = fixture();
    const input = root.all((el) => el.tag === "input")[0]!;
    input.value = "30";
    input.listeners.change!();
    expect(state.state.retentionDays).toBe(90);
    expect(save).not.toHaveBeenCalled();
    button("Save").listeners.click!();
    await Promise.all(tasks);
    expect(state.state.retentionDays).toBe(30);
    expect(prune).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    const next = root.all((el) => el.tag === "input")[0]!;
    next.value = "0";
    next.listeners.change!();
    button("Save").listeners.click!();
    await Promise.all(tasks);
    expect(errors).toHaveLength(1);
    expect(state.state.retentionDays).toBe(30);
    expect(prune).toHaveBeenCalledOnce();
  });
  it("keeps the confirmation before clearing history and preserves baselines/journal", async () => {
    const { state, save, button, tasks } = fixture();
    state.state.baselines.test = { "a.pdf": baseline() };
    const baselineBefore = structuredClone(state.state.baselines);
    const unresolved: Operation = {
      id: "interrupted",
      session: "batch",
      context: "test",
      at: Date.now(),
      path: "a.pdf",
      action: "upload",
      status: "Running",
      before: { local: null, remote: null },
    };
    state.state.journal = [unresolved];
    state.state.operations = [{ ...unresolved, status: "Failed" }];
    state.state.observations = [{ at: Date.now(), context: "test", files: [] }];
    button("Clear").listeners.click!();
    expect(save).not.toHaveBeenCalled();
    Modal.opened[0]!.close();
    await Promise.all(tasks);
    expect(state.state.observations).toHaveLength(1);
    expect(state.state.operations).toHaveLength(1);
    button("Clear").listeners.click!();
    Modal.opened[0]!.contentEl.all((el) => el.textContent === "Confirm")[0]!
      .listeners.click!();
    await Promise.all(tasks);
    expect(state.state.observations).toHaveLength(0);
    expect(state.state.operations).toHaveLength(0);
    expect(state.state.baselines).toEqual(baselineBefore);
    expect(state.state.journal).toEqual([unresolved]);
    expect(save).toHaveBeenCalledOnce();
  });
});

it("keeps token information in the account section and exposes remotes through a compact photo selector", () => {
  const f = fixture();
  const sections = f.root.all((el) =>
    el.classes.has("remote-sync-settings-card"),
  );
  const account = sections[0]!,
    remote = sections[1]!;
  expect(remote.children[0]!.textContent).toBe("Remote");
  expect(
    account.all((el) => el.classes.has("remote-sync-token-status")),
  ).toHaveLength(1);
  expect(
    remote.all((el) => el.classes.has("remote-sync-token-status")),
  ).toHaveLength(0);
  expect(
    remote.all((el) => el.classes.has("remote-sync-photo-selector")),
  ).toHaveLength(2);
  expect(
    remote.all((el) => el.classes.has("remote-sync-remote-card")),
  ).toHaveLength(0);
  expect(
    account.all((el) => el.classes.has("remote-sync-saved-account")),
  ).toHaveLength(0);
});

it("browses another account's tools and token status without switching the active remote", () => {
  const f = fixture(),
    first = f.credentials.credentials,
    second = { ...first, accountEmail: "second@example.test" };
  Object.defineProperty(f.credentials, "accounts", {
    get: () => [
      { id: "account-one", credentials: first },
      { id: "account-two", credentials: second },
    ],
  });
  vi.spyOn(f.credentials, "account").mockImplementation((ref) =>
    ref === "account-two" ? second : first,
  );
  f.tab.display();
  const option = f.root.all(
    (el) => el.attributes["data-value"] === "account-two",
  )[0]!;
  option.listeners.click!();
  expect(f.plugin.tokenStatus).toHaveBeenLastCalledWith("account-two");
  expect(f.plugin.run).not.toHaveBeenCalled();
  expect(f.credentials.activeRemote!.id).toBe("remote-one");
});
