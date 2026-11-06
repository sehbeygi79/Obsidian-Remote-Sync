import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "./obsidian";
import { uiDocument } from "./ui-host";
import { dismissNotifications, notify } from "../src/ui/Notifications";

describe("persistent notifications", () => {
  beforeEach(() => {
    Notice.instances = [];
    uiDocument.body.empty();
  });
  afterEach(() => dismissNotifications());

  it.each(["success", "warning", "error", "info"] as const)(
    "keeps %s notices until explicit dismissal",
    (tone) => {
      notify("Remote Sync: Test result", tone);
      const notice = Notice.instances[0]!;
      expect(notice.duration).toBe(0);
      expect(
        notice.containerEl.classes.has(`remote-sync-notice--${tone}`),
      ).toBe(true);
      expect(
        notice.containerEl.parentElement!.classes.has("remote-sync-notices"),
      ).toBe(true);
      expect(notice.containerEl.attributes.role).toBe(
        tone === "error" ? "alert" : "status",
      );
      const event = { stopPropagation: vi.fn() };
      notice.messageEl.listeners.click!(event);
      expect(event.stopPropagation).toHaveBeenCalled();
      expect(notice.containerEl.parentElement).not.toBeNull();
      notice.messageEl.all((el) => el.tag === "button")[0]!.listeners.click!(
        event,
      );
      expect(notice.containerEl.parentElement).toBeNull();
    },
  );

  it("stacks multiple notices and removes the plugin's notices on unload", () => {
    notify("First", "success");
    notify("Second", "warning");
    expect(
      uiDocument.body.querySelector(".remote-sync-notices")!.children,
    ).toHaveLength(2);
    dismissNotifications();
    expect(uiDocument.body.querySelector(".remote-sync-notices")).toBeNull();
  });
});
