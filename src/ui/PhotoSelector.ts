import type { Credentials } from "../auth/CredentialEncryption";
import { accountAvatar } from "./AccountIdentity";

export interface PhotoOption {
  id: string;
  title: string;
  description: string;
  account: Credentials;
}
/** A compact native disclosure with photo options and keyboard navigation. */
export function photoSelector(
  parent: HTMLElement,
  options: PhotoOption[],
  value: string,
  label: string,
  onSelect: (id: string) => void,
  disabled = false,
): { setValue: (id: string) => void } {
  const root = parent.createEl("details", {
    cls: "remote-sync-photo-selector",
    attr: { name: "remote-sync-selectors", "data-disabled": String(disabled) },
  });
  const trigger = root.createEl("summary", {
    attr: {
      "aria-label": label,
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      "aria-disabled": String(disabled),
    },
  });
  if (disabled) trigger.tabIndex = -1;
  const selected = trigger.createDiv({ cls: "remote-sync-selector-identity" });
  trigger.createEl("span", {
    text: "⌄",
    cls: "remote-sync-selector-chevron",
    attr: { "aria-hidden": "true" },
  });
  const menu = root.createDiv({
    cls: "remote-sync-selector-menu",
    attr: { role: "listbox", "aria-label": label },
  });
  const buttons: HTMLButtonElement[] = [];
  const identity = (target: HTMLElement, option: PhotoOption) => {
    accountAvatar(target, option.account);
    const text = target.createDiv({ cls: "remote-sync-selector-text" });
    text.createEl("strong", { text: option.title });
    text.createEl("span", { text: option.description });
  };
  const close = () => {
    root.open = false;
    trigger.setAttribute("aria-expanded", "false");
  };
  const setValue = (id: string) => {
    value = id;
    selected.empty();
    const option = options.find((option) => option.id === id) ?? options[0];
    if (option) {
      identity(selected, option);
      trigger.setAttribute(
        "aria-description",
        `${option.title}. ${option.description}`,
      );
      trigger.title = `${option.title} · ${option.description}`;
    }
    buttons.forEach((button, index) =>
      button.setAttribute(
        "aria-selected",
        String(options[index]!.id === value),
      ),
    );
  };
  for (const [index, option] of options.entries()) {
    const button = menu.createEl("button", {
      cls: "remote-sync-selector-option",
      attr: { type: "button", role: "option", "data-value": option.id },
    });
    button.disabled = disabled;
    identity(button, option);
    button.createEl("span", {
      text: "✓",
      cls: "remote-sync-selector-check",
      attr: { "aria-hidden": "true" },
    });
    button.addEventListener("click", () => {
      if (disabled) return;
      close();
      trigger.focus();
      if (option.id !== value) onSelect(option.id);
    });
    button.addEventListener("keydown", (event) => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? options.length - 1
              : (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  options.length) %
                options.length;
        buttons[next]?.focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        trigger.focus();
      }
    });
    buttons.push(button);
  }
  trigger.addEventListener("click", (event) => {
    if (disabled) event.preventDefault();
  });
  trigger.addEventListener("keydown", (event) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      root.open = true;
      trigger.setAttribute("aria-expanded", "true");
      buttons[event.key === "ArrowUp" ? buttons.length - 1 : 0]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  root.addEventListener("toggle", () => {
    if (disabled) root.open = false;
    trigger.setAttribute("aria-expanded", String(root.open));
  });
  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget as Node | null)) close();
  });
  setValue(value);
  return { setValue };
}
