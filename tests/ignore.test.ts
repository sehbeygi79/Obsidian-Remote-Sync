import { describe, expect, it } from "vitest";
import { IgnoreRules } from "../src/utils/IgnoreRules";

describe("vault ignore rules", () => {
  it("ignores files, folders and all descendants without matching similar names", () => {
    const rules = new IgnoreRules(["materials/private/", "notes/secret.md"]);
    for (const path of [
      "materials/private",
      "materials/private/deep/a.pdf",
      "notes/secret.md",
    ])
      expect(rules.matches(path)).toBe(true);
    for (const path of [
      "materials/private-copy/a.pdf",
      "notes/secret.md.bak",
      "other/materials/private/a.pdf",
    ])
      expect(rules.matches(path)).toBe(false);
  });
  it("supports basename wildcards, recursive globs and comments", () => {
    const rules = new IgnoreRules([
      "# comment",
      "",
      "*.tmp",
      "**/*.bak",
      "draft?.md",
      ".obsidian/",
    ]);
    for (const path of [
      "a.tmp",
      "notes/a.tmp",
      "a.bak",
      "one/two/a.bak",
      "draft1.md",
      ".obsidian/plugins/x/data.json",
    ])
      expect(rules.matches(path)).toBe(true);
    expect(rules.matches("notes/a.tmpx")).toBe(false);
    expect(rules.matches("draft12.md")).toBe(false);
  });
  it("supports explicit root anchoring and case/Unicode normalization", () => {
    const rules = new IgnoreRules(["/cache/", "./Notes/private.md", "café/"]);
    expect(rules.matches("cache/a")).toBe(true);
    expect(rules.matches("nested/cache/a")).toBe(false);
    expect(rules.matches("Notes/private.md")).toBe(true);
    expect(rules.matches("nested/Notes/private.md")).toBe(false);
    expect(rules.matches("CAFE\u0301/a")).toBe(true);
  });
  it("treats regex punctuation literally and validates unsupported patterns", () => {
    const rules = new IgnoreRules(["a[1].md", "a+b/", "(draft).md"]);
    expect(rules.matches("a[1].md")).toBe(true);
    expect(rules.matches("a1.md")).toBe(false);
    expect(rules.matches("a+b/file")).toBe(true);
    expect(rules.matches("(draft).md")).toBe(true);
    for (const pattern of [
      "../secret",
      "foo/../bar",
      "!keep.md",
      "a\\b",
      "a//b",
    ])
      expect(() => new IgnoreRules([pattern])).toThrow();
  });
});
