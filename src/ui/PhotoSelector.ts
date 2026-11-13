import type { Credentials } from "../auth/CredentialEncryption";
import { accountAvatar } from "./AccountIdentity";
import { setIcon } from "obsidian";

export interface PhotoOption {
  id: string;
  title: string;
  description: string;
  account?: Credentials;
  icon?: string;
}
export interface PhotoSelectorActions {
  heading?: string;
  onAdd?: () => void;
  addLabel?: string;
  onAuthorize?: (id: string) => void;
  onRemove?: (id: string) => void;
  canRemove?: (id: string) => boolean;
  onRename?: (id: string) => void;
}
/** A compact native disclosure with photo options and keyboard navigation. */
export function photoSelector(
  parent: HTMLElement,
  options: PhotoOption[],
  value: string,
  label: string,
  onSelect: (id: string) => void,
  disabled = false,
  actions: PhotoSelectorActions = {},
): {
  setValue: (id: string) => void;
  setDescription: (id: string, description: string) => void;
} {
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
  const selectedParent = actions.heading
    ? trigger.createDiv({ cls: "remote-sync-selector-summary" })
    : trigger;
  if (actions.heading)
    selectedParent.createEl("span", {
      text: actions.heading,
      cls: "remote-sync-selector-heading",
    });
  const selected = selectedParent.createDiv({
    cls: "remote-sync-selector-identity",
  });
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
  const descriptions = new Map<string, HTMLElement[]>();
  const identity = (target: HTMLElement, option: PhotoOption) => {
    if (option.account) accountAvatar(target, option.account);
    else {
      const icon = target.createEl("span", {
        cls: "remote-sync-selector-icon",
        attr: { "aria-hidden": "true" },
      });
      setIcon(icon, option.icon ?? "folder");
    }
    const text = target.createDiv({ cls: "remote-sync-selector-text" });
    text.createEl("strong", { text: option.title });
    const description = text.createEl("span", { text: option.description });
    const nodes = descriptions.get(option.id) ?? [];
    nodes.push(description);
    descriptions.set(option.id, nodes);
  };
  const iconButton = (
    parent: HTMLElement,
    icon: string,
    title: string,
    onClick: (event: MouseEvent) => void,
    disabledAction = false,
  ) => {
    const button = parent.createEl("button", {
      cls: "remote-sync-selector-action",
      attr: {
        type: "button",
        "aria-label": title,
        title,
      },
    });
    setIcon(button, icon);
    button.disabled = disabled || disabledAction;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!button.disabled) onClick(event);
    });
    return button;
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
  const setDescription = (id: string, description: string) => {
    const option = options.find((item) => item.id === id);
    if (!option) return;
    option.description = description;
    for (const node of descriptions.get(id) ?? [])
      node.textContent = description;
    if (id === value) {
      trigger.setAttribute(
        "aria-description",
        `${option.title}. ${option.description}`,
      );
      trigger.title = `${option.title} · ${option.description}`;
    }
  };
  for (const [index, option] of options.entries()) {
    const row = menu.createDiv({ cls: "remote-sync-selector-row" });
    const button = row.createEl("button", {
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
    if (actions.onAuthorize)
      iconButton(row, "key-round", `Authorize · ${option.title}`, () =>
        actions.onAuthorize?.(option.id),
      );
    if (actions.onRename)
      iconButton(row, "pencil", `Rename ${option.title}`, () =>
        actions.onRename?.(option.id),
      );
    if (actions.onRemove)
      iconButton(
        row,
        "trash-2",
        `${actions.onAuthorize ? "Remove account" : "Remove"} · ${option.title}`,
        () => actions.onRemove?.(option.id),
        actions.canRemove ? !actions.canRemove(option.id) : false,
      );
  }
  if (actions.onAdd) {
    const add = menu.createEl("button", {
      cls: "remote-sync-selector-add",
      attr: { type: "button" },
    });
    const icon = add.createEl("span", { cls: "remote-sync-selector-add-icon" });
    setIcon(icon, "plus");
    add.createEl("span", { text: actions.addLabel ?? "Add" });
    add.disabled = disabled;
    add.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;
      close();
      actions.onAdd?.();
    });
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
  return { setValue, setDescription };
}
