import { describe, expect, it, vi } from "vitest";
import { photoSelector } from "../src/ui/PhotoSelector";
import { UiElement } from "./ui-host";
import type { Credentials } from "../src/auth/CredentialEncryption";
const account: Credentials = {
  version: 1,
  clientType: "desktop",
  clientId: "client",
  clientSecret: "secret",
  refreshToken: "refresh",
  scopes: [],
  accountId: "account",
  accountEmail: "person@example.test",
  folderId: "",
  folderName: "",
  photoUrl: "https://lh3.googleusercontent.com/photo",
};
function fixture(disabled = false) {
  const root = new UiElement(),
    selected = vi.fn();
  const selector = photoSelector(
    root as unknown as HTMLElement,
    [
      {
        id: "one",
        title: "First remote",
        description: "First folder",
        account,
      },
      {
        id: "two",
        title: "Second remote",
        description: "Second folder",
        account,
      },
    ],
    "one",
    "Remote profile",
    selected,
    disabled,
  );
  const details = root.querySelector("details")!,
    summary = root.querySelector("summary")!,
    options = root.all((el) => el.attributes.role === "option");
  return { root, details, summary, options, selected, selector };
}
describe("photo selector", () => {
  it("shows photos and only the selected summary while collapsed, and waits for a committed selection", () => {
    const f = fixture();
    expect(f.details.open).toBe(false);
    expect(f.root.querySelector("img")!.attributes.src).toBe(account.photoUrl);
    expect(f.summary.attributes["aria-description"]).toContain("First remote");
    f.options[1]!.listeners.click!();
    expect(f.selected).toHaveBeenCalledWith("two");
    expect(f.options[0]!.attributes["aria-selected"]).toBe("true");
    f.selector.setValue("two");
    expect(f.options[1]!.attributes["aria-selected"]).toBe("true");
    expect(f.summary.attributes["aria-description"]).toContain("Second remote");
  });
  it("supports arrow navigation, Escape and dismissal when focus leaves the selector", () => {
    const f = fixture(),
      preventDefault = vi.fn(),
      stopPropagation = vi.fn();
    const firstFocus = vi.spyOn(f.options[0]!, "focus"),
      secondFocus = vi.spyOn(f.options[1]!, "focus"),
      triggerFocus = vi.spyOn(f.summary, "focus");
    f.summary.listeners.keydown!({
      key: "ArrowDown",
      preventDefault,
      stopPropagation,
    });
    expect(f.details.open).toBe(true);
    expect(firstFocus).toHaveBeenCalled();
    f.options[0]!.listeners.keydown!({
      key: "ArrowDown",
      preventDefault,
      stopPropagation,
    });
    expect(secondFocus).toHaveBeenCalled();
    f.options[1]!.listeners.keydown!({
      key: "Escape",
      preventDefault,
      stopPropagation,
    });
    expect(f.details.open).toBe(false);
    expect(triggerFocus).toHaveBeenCalled();
    f.details.open = true;
    f.details.listeners.focusout!({
      relatedTarget: f.options[0],
      stopPropagation,
    });
    expect(f.details.open).toBe(true);
    f.details.listeners.focusout!({ relatedTarget: null, stopPropagation });
    expect(f.details.open).toBe(false);
  });
  it("blocks opening and changing disabled selectors during scan/apply", () => {
    const f = fixture(true),
      preventDefault = vi.fn();
    expect(f.summary.attributes["aria-disabled"]).toBe("true");
    expect(f.options.every((el) => el.disabled)).toBe(true);
    f.summary.listeners.click!({ preventDefault, stopPropagation: vi.fn() });
    expect(preventDefault).toHaveBeenCalled();
    f.options[1]!.listeners.click!();
    expect(f.selected).not.toHaveBeenCalled();
  });
});
