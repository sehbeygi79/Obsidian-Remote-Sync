// Small UI host for modal lifecycle tests; no browser or Google access is needed.
interface UiEvent {
  stopPropagation(): void;
  preventDefault?(): void;
  key?: string;
  target?: UiElement;
  relatedTarget?: UiElement | null;
  isComposing?: boolean;
}
export class UiElement {
  children: UiElement[] = [];
  classes = new Set<string>();
  textContent = "";
  attributes: Record<string, string> = {};
  checked = false;
  disabled = false;
  hidden = false;
  open = false;
  max = 1;
  parentElement: UiElement | null = null;
  value = "";
  type = "";
  autocomplete = "";
  listeners: Record<string, (event?: UiEvent) => void> = {};
  constructor(public tag = "div") {}
  empty(): void {
    this.children = [];
  }
  focus(): void {}
  contains(child: UiElement | null): boolean {
    return (
      child === this || this.children.some((element) => element.contains(child))
    );
  }
  addClass(...names: string[]): void {
    names.forEach((name) => this.classes.add(name));
  }
  get ownerDocument(): UiDocument {
    return uiDocument;
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  appendChild(child: UiElement): UiElement {
    child.remove();
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  remove(): void {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (child) => child !== this,
      );
    this.parentElement = null;
  }
  createEl(
    tag: string,
    options: {
      text?: string;
      cls?: string;
      attr?: Record<string, string>;
      type?: string;
    } = {},
  ): UiElement {
    const child = new UiElement(tag);
    child.textContent = options.text ?? "";
    child.attributes = { ...options.attr };
    if (options.type) child.attributes.type = options.type;
    if (options.cls) child.addClass(...options.cls.split(" "));
    this.appendChild(child);
    return child;
  }
  createDiv(options = {}): UiElement {
    return this.createEl("div", options);
  }
  addEventListener(event: string, callback: (event?: UiEvent) => void): void {
    this.listeners[event] = callback;
  }
  all(predicate: (element: UiElement) => boolean): UiElement[] {
    return [
      ...(predicate(this) ? [this] : []),
      ...this.children.flatMap((child) => child.all(predicate)),
    ];
  }
  querySelector(selector: string): UiElement | null {
    return (
      this.all((el) =>
        selector.startsWith(".")
          ? el.classes.has(selector.slice(1))
          : selector === '[role="status"]'
            ? el.attributes.role === "status"
            : el.tag === selector,
      )[0] ?? null
    );
  }
}

class UiDocument {
  body = new UiElement("body");
  querySelector(selector: string): UiElement | null {
    return this.body.querySelector(selector);
  }
}
export const uiDocument = new UiDocument();

export class Modal {
  static opened: Modal[] = [];
  contentEl = new UiElement();
  modalEl = new UiElement();
  selection: unknown = null;
  constructor(_app: unknown) {}
  open(): void {
    // Obsidian Modal.open() captures editor focus/selection before onOpen().
    // This internal field is not declared in the public Obsidian typings.
    this.selection = { range: null, focusEl: null };
    Modal.opened.push(this);
    this.onOpen();
  }
  close(): void {
    this.onClose();
    Modal.opened = Modal.opened.filter((modal) => modal !== this);
  }
  onOpen(): void {}
  onClose(): void {}
}

class Control {
  constructor(private element: UiElement) {}
  get buttonEl(): UiElement {
    return this.element;
  }
  get inputEl(): UiElement {
    return this.element;
  }
  get selectEl(): UiElement {
    return this.element;
  }
  setButtonText(text: string): this {
    this.element.textContent = text;
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.element.disabled = disabled;
    return this;
  }
  setCta(): this {
    return this;
  }
  setWarning(): this {
    return this;
  }
  onClick(callback: () => void): this {
    this.element.addEventListener("click", callback);
    return this;
  }
  addOption(value: string, label: string): this {
    const option = this.element.createEl("option", { text: label });
    option.value = value;
    return this;
  }
  setValue(value: string): this {
    this.element.value = value;
    return this;
  }
  onChange(callback: (value: string) => void): this {
    this.element.addEventListener("change", () => callback(this.element.value));
    return this;
  }
}

export class Setting {
  controlEl: UiElement;
  private info: UiElement;
  constructor(element: UiElement) {
    const row = element.createDiv();
    this.info = row.createDiv();
    this.controlEl = row.createDiv();
  }
  setName(text: string): this {
    this.info.createEl("span", { text });
    return this;
  }
  setDesc(text: string): this {
    this.info.createEl("p", { text });
    return this;
  }
  addButton(callback: (control: Control) => unknown): this {
    callback(new Control(this.controlEl.createEl("button")));
    return this;
  }
  addDropdown(callback: (control: Control) => unknown): this {
    callback(new Control(this.controlEl.createEl("select")));
    return this;
  }
  addText(callback: (control: Control) => unknown): this {
    callback(new Control(this.controlEl.createEl("input")));
    return this;
  }
}
