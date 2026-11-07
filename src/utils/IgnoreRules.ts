/** A small, additive ignore format: vault paths, basename rules and *, **, ?.
 * Folder matches also exclude descendants. Negation is deliberately unsupported.
 */
export class IgnoreRules {
  private patterns: RegExp[] = [];
  constructor(lines: string[] = []) {
    if (!Array.isArray(lines) || lines.length > 500)
      throw new Error("Use at most 500 ignore entries");
    for (const line of lines) {
      if (typeof line !== "string") throw new Error("Invalid ignore entry");
      let pattern = line.trim().normalize("NFC");
      if (!pattern || pattern.startsWith("#")) continue;
      if (
        pattern.length > 512 ||
        pattern.includes("\\") ||
        [...pattern].some(
          (ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127,
        ) ||
        pattern.startsWith("!")
      )
        throw new Error(
          "Ignore entries support vault paths, *, ** and ?. Negation and backslashes are not supported.",
        );
      const anchored = pattern.startsWith("/") || pattern.startsWith("./");
      if (pattern.startsWith("./")) pattern = pattern.slice(2);
      else if (pattern.startsWith("/")) pattern = pattern.slice(1);
      if (pattern.endsWith("/")) pattern = pattern.slice(0, -1);
      if (
        pattern
          .split("/")
          .some((part) => !part || part === "." || part === "..")
      )
        throw new Error("Ignore entries must be paths inside the vault");
      const prefix = anchored || pattern.includes("/") ? "^" : "(?:^|/)";
      let expression = "";
      for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i]!;
        if (ch === "*" && pattern[i + 1] === "*") {
          while (pattern[i + 1] === "*") i++;
          if (pattern[i + 1] === "/") {
            expression += "(?:.*/)?";
            i++;
          } else expression += ".*";
        } else if (ch === "*") expression += "[^/]*";
        else if (ch === "?") expression += "[^/]";
        else expression += ch.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      }
      this.patterns.push(new RegExp(`${prefix}${expression}(?:/|$)`, "iu"));
    }
  }
  matches(vaultPath: string): boolean {
    const path = vaultPath.normalize("NFC");
    return this.patterns.some((pattern) => pattern.test(path));
  }
}
