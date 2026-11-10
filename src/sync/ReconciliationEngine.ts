import { affected, assertUniquePaths } from "../utils/paths";
import type { Action, Baseline, Change, FileState, Snapshot } from "./types";
export function equal(
  a: FileState | null | undefined,
  b: FileState | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  if (a.size !== b.size) return false;
  if (a.hashes.sha256 && b.hashes.sha256)
    return a.hashes.sha256 === b.hashes.sha256;
  return !!a.hashes.md5 && !!b.hashes.md5 && a.hashes.md5 === b.hashes.md5;
}
export function unchanged(f: FileState | null, b: Baseline): boolean {
  return equal(
    f,
    b.hash
      ? { path: b.path, size: b.size, hashes: b.hash, modifiedAt: 0 }
      : null,
  );
}
export function fingerprint(f: FileState | null | undefined): string {
  return f
    ? JSON.stringify([
        f.path,
        f.size,
        f.hashes.sha256 ?? "",
        f.hashes.md5 ?? "",
        f.modifiedAt,
        f.localId ?? "",
        f.id ?? "",
        f.version ?? "",
        f.parents ?? [],
      ])
    : "missing";
}
/** Compare the same version using a common verified digest, allowing SHA-only
 * snapshots to match older records which also contain MD5. */
export function sameVersion(
  a: FileState | null | undefined,
  b: FileState | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    equal(a, b) &&
    fingerprint({ ...a, hashes: {} }) === fingerprint({ ...b, hashes: {} })
  );
}
/** Compute legacy MD5 only for files that need it for equality or rename
 * matching. A single old remote file must not trigger MD5 for the entire vault. */
export function legacyHashPaths(
  local: Snapshot,
  remote: Snapshot,
  baselines: Record<string, Baseline>,
): string[] {
  const needsMd5 = (hash: FileState["hashes"] | null) =>
    !!hash?.md5 && !hash.sha256;
  const paths = new Set<string>();
  for (const file of Object.values(remote.files))
    if (needsMd5(file.hashes) && local.files[file.path]) paths.add(file.path);
  const records = Object.values(baselines);
  const baselinePaths = new Set(records.map((record) => record.path));
  const byId = new Map(
    Object.values(remote.files).map((file) => [file.id, file]),
  );
  for (const record of records) {
    const source = byId.get(record.remoteId) ?? remote.files[record.path];
    if (!needsMd5(record.hash) && !needsMd5(source?.hashes ?? null)) continue;
    for (const file of Object.values(local.files))
      if (
        file.path === record.path ||
        (!!file.localId && file.localId === record.local?.localId) ||
        unchanged(file, record) ||
        (needsMd5(record.hash) && !baselinePaths.has(file.path))
      )
        paths.add(file.path);
  }
  return [...paths];
}
export function reconcile(
  local: Snapshot,
  remote: Snapshot,
  baselines: Record<string, Baseline>,
): Change[] {
  assertUniquePaths(Object.keys(local.files));
  assertUniquePaths(Object.keys(remote.files));
  const claimedL = new Set<string>(),
    claimedR = new Set<string>();
  const rows: Change[] = [];
  const newLocal = Object.values(local.files).filter(
    (f) => !Object.values(baselines).some((b) => b.path === f.path),
  );
  const missingB = Object.values(baselines).filter(
    (b) => b.hash && !local.files[b.path],
  );
  function row(
    key: string,
    path: string,
    l: FileState | null,
    r: FileState | null,
    b: Baseline | null,
    hint = "",
  ) {
    const lp = l?.path ?? path,
      rp = r?.path ?? path;
    if (l) claimedL.add(lp);
    if (r) claimedR.add(rp);
    let category: Change["category"],
      classification: string,
      explanation: string,
      actions: Action[],
      suggested: Action;
    if (
      [path, lp, rp].some((p) =>
        affected(p, [...local.blocked, ...remote.blocked]),
      )
    ) {
      category = "blocked";
      classification = "Unsupported or ambiguous path";
      explanation =
        "An unsupported object, duplicate name or inaccessible subtree blocks this path.";
      actions = ["skip"];
      suggested = "skip";
    } else if (l && r && lp !== rp) {
      category = "rename";
      classification =
        b && lp !== b.path && rp !== b.path
          ? "Conflicting paths"
          : lp !== b?.path
            ? "Local rename / move"
            : "Remote rename / move";
      explanation = equal(l, r)
        ? "File identity and unchanged content establish a path change."
        : "Path and content both differ. Resolve the path first, then rescan to review the content conflict. Path actions do not overwrite contents.";
      actions = ["local-path", "remote-path", "skip"];
      suggested = lp !== b?.path ? "local-path" : "remote-path";
    } else if (equal(l, r)) {
      category = "equal";
      classification = l
        ? b &&
          unchanged(l, b) &&
          lp === b.path &&
          (!b.remoteId || r?.id === b.remoteId)
          ? "Synchronized"
          : "Equal contents"
        : "Both deleted";
      explanation = l
        ? "Compatible content hashes agree. Timestamps do not determine equality."
        : "Both sides are missing; accept to record a confirmed tombstone.";
      actions = ["accept", "skip"];
      suggested = "accept";
    } else if (!b?.hash) {
      category = l && r ? "conflict" : "addition";
      classification =
        l && r
          ? "First-sync conflict"
          : l
            ? "Local addition"
            : "Remote addition";
      explanation =
        l && r
          ? "No confirmed baseline exists and content hashes differ."
          : "No previous confirmed copy exists. Absence is not evidence of deletion.";
      actions =
        l && r
          ? ["use-local", "use-remote", "skip"]
          : l
            ? ["upload", "skip"]
            : ["download", "skip"];
      suggested = l && r ? "skip" : l ? "upload" : "download";
    } else if (!l || !r) {
      const edited = !unchanged(l ?? r, b);
      category = edited ? "conflict" : "deletion";
      classification = !l
        ? edited
          ? "Delete-vs-edit conflict"
          : "Local deletion"
        : edited
          ? "Edit-vs-delete conflict"
          : "Remote deletion";
      explanation = `File was previously synchronized and is now missing ${!l ? "locally" : "remotely"}.${edited ? " The surviving content changed; applying deletion discards those edits." : " The surviving copy still matches the baseline."}`;
      actions = !l
        ? ["trash-remote", "download", "skip"]
        : ["trash-local", "upload", "skip"];
      suggested = "skip";
    } else {
      const lc = !unchanged(l, b),
        rc = !unchanged(r, b);
      category = lc && rc ? "conflict" : "modification";
      classification =
        lc && rc
          ? "Both sides modified"
          : lc
            ? "Local modification"
            : "Remote modification";
      explanation =
        lc && rc
          ? "Both hashes differ from the last confirmed baseline and from each other."
          : lc
            ? "Remote hash matches the baseline; local hash changed."
            : "Local hash matches the baseline; remote hash changed.";
      actions = ["use-local", "use-remote", "skip"];
      suggested = lc && rc ? "skip" : lc ? "use-local" : "use-remote";
    }
    rows.push({
      key,
      path,
      localPath: lp,
      remotePath: rp,
      local: l,
      remote: r,
      baseline: b,
      category,
      classification,
      explanation: explanation + hint,
      actions,
      suggested,
    });
  }
  for (const b of Object.values(baselines).sort((a, b) =>
    a.key.localeCompare(b.key),
  )) {
    let r = b.remoteId
      ? (Object.values(remote.files).find((f) => f.id === b.remoteId) ?? null)
      : null;
    r ??= remote.files[b.path] ?? null;
    let l = local.files[b.path] ?? null,
      hint = "";
    if (b.local?.localId) {
      const identities = Object.values(local.files).filter(
        (f) => f.localId === b.local!.localId && !claimedL.has(f.path),
      );
      if (identities.length === 1) l = identities[0]!;
    }
    if (!l && r && r.path !== b.path) l = local.files[r.path] ?? null;
    if (!l && b.hash) {
      const candidates = newLocal.filter(
        (f) => !claimedL.has(f.path) && unchanged(f, b),
      );
      const owners = missingB.filter((other) =>
        candidates.some((f) => unchanged(f, other)),
      );
      if (candidates.length === 1 && owners.length === 1) l = candidates[0]!;
      else if (candidates.length)
        hint =
          " Possible rename: multiple same-hash identities make matching ambiguous; review separate changes.";
      else if (newLocal.length)
        hint =
          " A rename with edited contents cannot be identified reliably from portable file metadata; review additions separately.";
    }
    if (l && claimedL.has(l.path)) l = null;
    if (r && claimedR.has(r.path)) r = null;
    if (l || r || b.hash) row(b.key, b.path, l, r, b, hint);
  }
  const paths = new Set([
    ...Object.keys(local.files),
    ...Object.keys(remote.files),
    ...local.blocked.filter(Boolean),
    ...remote.blocked.filter(Boolean),
  ]);
  for (const p of [...paths].sort()) {
    const l = claimedL.has(p) ? null : (local.files[p] ?? null),
      r = claimedR.has(p) ? null : (remote.files[p] ?? null);
    if (
      l ||
      r ||
      (affected(p, [...local.blocked, ...remote.blocked]) &&
        !rows.some((c) => c.path === p))
    )
      row(`path:${p}`, p, l, r, null);
  }
  return rows;
}
