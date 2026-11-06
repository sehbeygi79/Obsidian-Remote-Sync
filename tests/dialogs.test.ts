import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { confirm, form } from "../src/ui/Dialogs";
import { Modal } from "./ui-host";

describe("Remote Sync dialogs", () => {
  beforeEach(() => {
    Modal.opened = [];
  });
  it("submits passphrase forms through native form submission and clears inputs", async () => {
    const result = form({} as App, "Unlock credentials", [
      { key: "passphrase", label: "Passphrase", secret: true },
    ]);
    const modal = Modal.opened[0]!;
    expect(
      modal.contentEl.querySelector(".remote-sync-eyebrow")!.textContent,
    ).toBe("REMOTE SYNC");
    const input = modal.contentEl.querySelector("input")!;
    input.value = "test passphrase entered without a change event";
    const buttons = modal.contentEl.all((el) => el.tag === "button");
    expect(buttons.find((el) => el.textContent === "Continue")!.type).toBe(
      "submit",
    );
    expect(buttons.find((el) => el.textContent === "Cancel")!.type).toBe(
      "button",
    );
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    const submit = modal.contentEl.querySelector("form")!.listeners.submit!;
    submit(event);
    submit(event);
    await expect(result).resolves.toEqual({
      passphrase: "test passphrase entered without a change event",
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(input.value).toBe("");
    expect(Modal.opened).toHaveLength(0);
  });
  it("keeps cancellation separate from form submission", async () => {
    const result = form({} as App, "Unlock credentials", [
      { key: "passphrase", label: "Passphrase", secret: true },
    ]);
    Modal.opened[0]!.contentEl.all((el) => el.textContent === "Cancel")[0]!
      .listeners.click!();
    await expect(result).resolves.toBeNull();
  });
  it("accepts Enter in a passphrase input but waits for IME composition to finish", async () => {
    const result = form({} as App, "Unlock credentials", [
      { key: "passphrase", label: "Passphrase", secret: true },
    ]);
    const modal = Modal.opened[0]!;
    const input = modal.contentEl.querySelector("input")!;
    input.value = "a test passphrase";
    const event = {
      key: "Enter",
      target: input,
      isComposing: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const handler = modal.contentEl.querySelector("form")!.listeners.keydown!;
    handler(event);
    expect(Modal.opened).toContain(modal);
    expect(event.preventDefault).not.toHaveBeenCalled();
    handler({ ...event, isComposing: false });
    await expect(result).resolves.toEqual({ passphrase: "a test passphrase" });
    expect(event.preventDefault).toHaveBeenCalled();
  });
  it("adds the shared header to confirmations and does not confirm automatically", async () => {
    const result = confirm(
      {} as App,
      "Change remote folder",
      "Use the selected folder?",
    );
    const modal = Modal.opened[0]!;
    expect(
      modal.contentEl.querySelector(".remote-sync-eyebrow")!.textContent,
    ).toBe("REMOTE SYNC");
    modal.close();
    await expect(result).resolves.toBe(false);
  });
});
