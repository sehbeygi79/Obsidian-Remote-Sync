import { CommitBatch } from "../utils/CommitBatch";
import { concurrentTransfers } from "./TransferSettings";
import { affected, relative } from "../utils/paths";
import { contentHashes, randomId } from "../utils/hashing";
import { equal, sameVersion } from "./ReconciliationEngine";
import type {
  Baseline,
  Change,
  LocalBackend,
  Operation,
  RemoteBackend,
  Review,
  Selection,
  Snapshot,
  TransferProgress,
} from "./types";
import type { SyncStateStore } from "./SyncStateStore";
export function massDeletion(
  selected: Selection[],
  baselines: Record<string, Baseline>,
  review?: Review,
): boolean {
  const tracked = review
    ? new Set(review.changes.map((change) => change.baseline?.key))
    : null;
  const total = Object.values(baselines).filter(
    (b) => b.hash && (!tracked || tracked.has(b.key)),
  ).length;
  const deleted = new Set(
    selected
      .filter((s) => s.action === "trash-local" || s.action === "trash-remote")
      .filter((s) => s.change.baseline?.hash)
      .map((s) => s.change.baseline!.key),
  ).size;
  return total > 0 && deleted / total > 0.25;
}
export class SyncExecutor {
  busy = false;
  private cancelled = false;
  constructor(
    private local: LocalBackend,
    private remote: RemoteBackend,
    private store: SyncStateStore,
    private context: () => string,
    private reviewValid: () => boolean = () => true,
    private isIgnored: (path: string) => boolean = () => false,
  ) {}
  cancel(): void {
    this.cancelled = true;
    this.remote.cancelApply?.();
  }
  private localSnapshot(
    change: Change,
    capturedRemote?: Snapshot,
  ): Promise<Snapshot> {
    const paths = [
      ...new Set([change.path, change.localPath, change.remotePath]),
    ];
    return this.local.scan(paths, {
      includeMd5: [
        change.local,
        change.remote,
        ...Object.values(capturedRemote?.files ?? {}),
      ].some((file) => !!file?.hashes.md5 && !file.hashes.sha256),
    });
  }
  private async snapshots(
    change: Change,
    preparedRemote?: Promise<Snapshot>,
  ): Promise<{ local: Snapshot; remote: Snapshot }> {
    const paths = [
      ...new Set([change.path, change.localPath, change.remotePath]),
    ];
    const [local, remote] = await Promise.all([
      this.localSnapshot(change),
      preparedRemote ?? this.remote.scan(paths),
    ]);
    // A new upload may first reveal an MD5-only remote during verification.
    // Add compatibility hashes only for those actual paths, never assume every
    // provider will return SHA-256 for newly created files.
    const legacyPaths = Object.values(remote.files)
      .filter(
        (file) =>
          file.hashes.md5 &&
          !file.hashes.sha256 &&
          local.files[file.path] &&
          !local.files[file.path]!.hashes.md5,
      )
      .map((file) => file.path);
    if (legacyPaths.length) {
      const legacy = await this.local.scan(legacyPaths, { includeMd5: true });
      if (
        legacy.identity !== local.identity ||
        legacyPaths.some(
          (path) => !sameVersion(local.files[path], legacy.files[path]),
        )
      )
        throw new Error(
          "Needs Rescan: local content changed during checksum verification",
        );
      Object.assign(local.files, legacy.files);
      local.blocked = [...new Set([...local.blocked, ...legacy.blocked])];
    }
    return { local, remote };
  }
  private validate(
    review: Review,
    c: Change,
    current: { local: Snapshot; remote: Snapshot },
  ): void {
    if (
      !this.reviewValid() ||
      this.context() !== review.context ||
      current.remote.identity !== review.remote.identity ||
      current.local.identity !== review.local.identity
    )
      throw new Error(
        "Needs Rescan: account, folder or device context changed",
      );
    for (const p of new Set([c.path, c.localPath, c.remotePath])) {
      relative(p);
      if (this.isIgnored(p)) throw new Error("Needs Rescan: path is ignored");
      if (affected(p, [...current.local.blocked, ...current.remote.blocked]))
        throw new Error("Needs Rescan: path is blocked");
      if (
        !sameVersion(current.local.files[p], review.local.files[p]) ||
        !sameVersion(current.remote.files[p], review.remote.files[p])
      )
        throw new Error("Needs Rescan: reviewed state changed");
    }
  }
  async apply(
    review: Review,
    selected: Selection[],
    confirmed: boolean,
    massConfirmed = false,
    onProgress?: (op: Operation, index: number, total: number) => void,
    onTransferProgress?: (progress: TransferProgress[]) => void,
  ): Promise<Operation[]> {
    if (this.busy) throw new Error("Apply already in progress");
    if (!confirmed) throw new Error("Explicit operation confirmation required");
    const baseline = this.store.state.baselines[review.context] ?? {};
    if (massDeletion(selected, baseline, review) && !massConfirmed)
      throw new Error(
        "Additional confirmation required: more than 25% of synchronized files would be trashed",
      );
    if (!this.reviewValid() || this.context() !== review.context)
      throw new Error("Needs Rescan: storage context changed");
    if (new Set(selected.map((s) => s.change.key)).size !== selected.length)
      throw new Error("Duplicate selected change");
    for (const s of selected)
      if (
        !review.changes.includes(s.change) ||
        !s.change.actions.includes(s.action)
      )
        throw new Error("Invalid reviewed action");
    this.busy = true;
    this.cancelled = false;
    const results = new Array<Operation>(selected.length),
      session = randomId(),
      limit = concurrentTransfers(this.store.state.maxConcurrentTransfers),
      transfers = new Map<number, TransferProgress>();
    const prepared = new Map<number, Promise<Snapshot>>();
    let completed = 0;
    let persistenceError: unknown;
    let persistenceFailed = false;
    const stateWrites = new CommitBatch(async (mutations) => {
      if (persistenceFailed) throw persistenceError;
      const checkpoint = structuredClone(this.store.state);
      try {
        for (const mutate of mutations) mutate();
        await this.store.save();
      } catch (error) {
        this.store.state = checkpoint;
        persistenceFailed = true;
        persistenceError = error;
        throw error;
      }
    });
    const persist = (mutate: () => void) => stateWrites.run(mutate);
    const transferProgress = (index: number, progress: TransferProgress) => {
      transfers.set(index, progress);
      onTransferProgress?.(
        [...transfers.values()].map((item) => ({ ...item })),
      );
    };
    const execute = async (index: number): Promise<void> => {
      const { change: c, action } = selected[index]!;
      const op: Operation = {
        id: randomId(),
        session,
        at: Date.now(),
        context: review.context,
        remoteProfileId: review.profileId,
        remoteName: review.remoteName,
        path: c.path,
        action,
        status: "Running",
        before: { local: c.local, remote: c.remote },
      };
      results[index] = op;
      if (action === "skip") {
        op.status = "Skipped";
        op.finishedAt = Date.now();
        await persist(() => {
          this.store.state.operations.push(op);
        });
        onProgress?.(op, ++completed, selected.length);
        return;
      }
      let journaled = false;
      try {
        const direction =
          action === "upload" || action === "use-local"
            ? "upload"
            : action === "download" || action === "use-remote"
              ? "download"
              : null;
        const source =
          direction === "upload"
            ? c.local
            : direction === "download"
              ? c.remote
              : null;
        if (direction && source)
          transferProgress(index, {
            path: source.path,
            direction,
            transferred: 0,
            total: source.size,
            phase: "preparing",
          });
        const preparedRemote = prepared.get(index);
        prepared.delete(index);
        const current = await this.snapshots(c, preparedRemote);
        if (this.cancelled) throw new Error("Operation cancelled");
        this.validate(review, c, current);
        if (c.category === "blocked")
          throw new Error("Needs Rescan: unsupported path");
        if (action === "upload" && !c.remote)
          op.remoteId = await this.remote.reserveId();
        await persist(() => {
          this.store.state.journal.push(op);
        });
        journaled = true;
        let resultingPath = c.local?.path ?? c.remote?.path ?? c.path;
        if (action === "upload" || action === "use-local") {
          if (!c.local) throw new Error("Missing local source");
          const transfer: TransferProgress = {
            path: c.local.path,
            direction: "upload",
            transferred: 0,
            total: c.local.size,
            phase: "preparing",
          };
          const bytes = await this.local.read(c.local.path);
          if (this.cancelled) throw new Error("Operation cancelled");
          if (
            !equal(c.local, {
              ...c.local,
              size: bytes.byteLength,
              hashes: await contentHashes(
                bytes,
                !c.local.hashes.sha256 && !!c.local.hashes.md5,
              ),
            })
          )
            throw new Error("Needs Rescan: upload source changed");
          // Transfer preparation can take time; revalidate again before touching destination.
          this.validate(review, c, await this.snapshots(c));
          if (persistenceFailed) throw persistenceError;
          await this.remote.upload(
            c.local.path,
            bytes,
            c.remote,
            op.remoteId,
            onTransferProgress
              ? (transferred, total) => {
                  Object.assign(transfer, {
                    transferred,
                    total,
                    phase: "transferring",
                  });
                  transferProgress(index, { ...transfer });
                }
              : undefined,
          );
          if (this.cancelled) throw new Error("Operation cancelled");
          transferProgress(index, {
            ...transfer,
            transferred: bytes.byteLength,
            phase: "verifying",
          });
          resultingPath = c.local.path;
        } else if (action === "download" || action === "use-remote") {
          if (!c.remote) throw new Error("Missing remote source");
          const transfer: TransferProgress = {
            path: c.remote.path,
            direction: "download",
            transferred: 0,
            total: c.remote.size,
            phase: "preparing",
          };
          const bytes = await this.remote.read(
            c.remote,
            onTransferProgress
              ? (transferred, total) => {
                  Object.assign(transfer, {
                    transferred,
                    total,
                    phase: "transferring",
                  });
                  transferProgress(index, { ...transfer });
                }
              : undefined,
          );
          if (this.cancelled) throw new Error("Operation cancelled");
          transferProgress(index, {
            ...transfer,
            transferred: bytes.byteLength,
            phase: "verifying",
          });
          if (
            !equal(c.remote, {
              ...c.remote,
              size: bytes.byteLength,
              hashes: await contentHashes(
                bytes,
                !c.remote.hashes.sha256 && !!c.remote.hashes.md5,
              ),
            })
          )
            throw new Error(
              "Needs Rescan: downloaded content differs from preview",
            );
          // The captured source version defines this download. Recheck only the
          // local destination here; later remote edits belong to the next scan.
          this.validate(review, c, {
            local: await this.localSnapshot(c, current.remote),
            remote: current.remote,
          });
          if (persistenceFailed) throw persistenceError;
          if (this.cancelled) throw new Error("Operation cancelled");
          await this.local.write(c.remote.path, bytes, c.local);
          resultingPath = c.remote.path;
        } else if (action === "trash-local") {
          if (!c.local) throw new Error("Missing local file");
          if (this.cancelled) throw new Error("Operation cancelled");
          await this.local.trash(c.local.path, c.local);
          resultingPath = c.local.path;
        } else if (action === "trash-remote") {
          if (!c.remote) throw new Error("Missing remote file");
          if (this.cancelled) throw new Error("Operation cancelled");
          await this.remote.trash(c.remote);
          resultingPath = c.remote.path;
        } else if (action === "local-path") {
          if (!c.local || !c.remote) throw new Error("Missing rename source");
          if (this.cancelled) throw new Error("Operation cancelled");
          if (current.remote.files[c.local.path])
            throw new Error("Needs Rescan: remote rename destination occupied");
          await this.remote.rename(c.remote, c.local.path);
          resultingPath = c.local.path;
        } else if (action === "remote-path") {
          if (!c.local || !c.remote) throw new Error("Missing rename source");
          if (this.cancelled) throw new Error("Operation cancelled");
          if (current.local.files[c.remote.path])
            throw new Error("Needs Rescan: local rename destination occupied");
          await this.local.rename(c.local.path, c.remote.path, c.local);
          resultingPath = c.remote.path;
        }
        const after =
          action === "download" || action === "use-remote"
            ? {
                local: await this.localSnapshot(c, current.remote),
                remote: current.remote,
              }
            : await this.snapshots(c);
        if (
          !this.reviewValid() ||
          this.context() !== review.context ||
          after.remote.identity !== review.remote.identity ||
          after.local.identity !== review.local.identity
        )
          throw new Error(
            "Needs Rescan: storage identity changed during operation",
          );
        if (
          affected(resultingPath, [
            ...after.local.blocked,
            ...after.remote.blocked,
          ])
        )
          throw new Error("Verification blocked by unsupported path");
        const l = after.local.files[resultingPath] ?? null,
          r = after.remote.files[resultingPath] ?? null;
        if (action === "local-path" || action === "remote-path") {
          const oldPath = action === "local-path" ? c.remotePath : c.localPath;
          const changedSide =
            action === "local-path" ? after.remote : after.local;
          if (
            changedSide.files[oldPath] ||
            !l ||
            !r ||
            r.id !== c.remote?.id ||
            !equal(l, c.local) ||
            !equal(r, c.remote)
          )
            throw new Error("Rename verification failed");
        } else if (action === "trash-local" || action === "trash-remote") {
          if (l || r) throw new Error("Trash verification failed");
        } else if (!equal(l, r) || (action !== "accept" && (!l || !r)))
          throw new Error("Content verification failed");
        if (
          r &&
          (c.remote?.id || op.remoteId) &&
          r.id !== (c.remote?.id ?? op.remoteId)
        )
          throw new Error("Remote identity verification failed");
        if (action === "upload" || action === "use-local") {
          // The unchanged local file bridges a SHA-only preview and a newly
          // MD5-only remote without weakening either source/version check.
          if (!sameVersion(l, c.local) || !equal(r, l))
            throw new Error("Needs Rescan: source changed during upload");
        } else if (action === "download" || action === "use-remote") {
          // r is the preparation snapshot, not a claim about the current remote.
          // Persist it so the next manual scan can detect newer edits/deletions.
          if (!sameVersion(r, c.remote) || !equal(l, c.remote))
            throw new Error("Needs Rescan: source changed during download");
        } else if (action === "accept") {
          if (!sameVersion(l, c.local) || !sameVersion(r, c.remote))
            throw new Error("Needs Rescan: equality acceptance changed");
        }
        await persist(() => {
          op.after = { local: l, remote: r };
          op.status = "Success";
          op.finishedAt = Date.now();
          if (equal(l, r)) {
            const records = (this.store.state.baselines[review.context] ??= {});
            const key = c.baseline?.key ?? randomId();
            records[key] = {
              key,
              path: resultingPath,
              hash: l ? { ...l.hashes, ...r?.hashes } : null,
              size: l?.size ?? 0,
              remoteId: r?.id ?? c.baseline?.remoteId,
              syncedAt: Date.now(),
              local: l,
              remote: r,
            };
          }
          this.store.state.operations.push(op);
          this.store.state.journal = this.store.state.journal.filter(
            (j) => j.id !== op.id,
          );
          this.store.prune();
        });
      } catch (e) {
        if (persistenceFailed) throw persistenceError;
        const message = e instanceof Error ? e.message : "Operation failed";
        op.status =
          this.cancelled || message === "Operation cancelled"
            ? "Cancelled"
            : message.includes("Needs Rescan")
              ? "Needs Rescan"
              : "Failed";
        // Persist fixed diagnostics, never raw HTTP bodies, tokens or file contents.
        op.reason =
          op.status === "Cancelled"
            ? "Cancelled by the user. Rescan to confirm any partially completed remote transfer."
            : op.status === "Needs Rescan"
              ? "Reviewed source, destination or identity changed; review a fresh scan."
              : "Operation or verification failed. Inspect both sides and rescan; no automatic retry.";
        op.finishedAt = Date.now();
        await persist(() => {
          this.store.state.operations.push(op);
          if (!journaled)
            this.store.state.journal = this.store.state.journal.filter(
              (j) => j.id !== op.id,
            );
        });
      } finally {
        transfers.delete(index);
        onTransferProgress?.(
          [...transfers.values()].map((item) => ({ ...item })),
        );
      }
      onProgress?.(op, ++completed, selected.length);
    };
    const active = new Map<Promise<void>, Selection>();
    const conflicts = (a: Selection, b: Selection): boolean => {
      const paths = (s: Selection) => [
        s.change.path,
        s.change.localPath,
        s.change.remotePath,
      ];
      return (
        paths(a).some((path) => affected(path, paths(b))) ||
        (!!a.change.remote?.id && a.change.remote.id === b.change.remote?.id) ||
        (!!a.change.baseline &&
          a.change.baseline.key === b.change.baseline?.key)
      );
    };
    let executionError: unknown;
    let executionFailed = false;
    const start = (index: number) => {
      const task = execute(index)
        .catch((error) => {
          executionFailed = true;
          executionError ??= error;
        })
        .finally(() => {
          active.delete(task);
        });
      active.set(task, selected[index]!);
    };
    let next = 0;
    const prepareAhead = () => {
      // Metadata only: no file buffers, journals or mutations for queued work.
      // Do not look across a barrier or a path/identity dependency. Fresh checks
      // after byte preparation still guard every destination mutation.
      for (
        let index = next;
        index < selected.length && prepared.size < limit;
        index++
      ) {
        if (prepared.has(index)) continue;
        const item = selected[index]!;
        if (
          !["upload", "download", "use-local", "use-remote"].includes(
            item.action,
          ) ||
          [...active.values()].some((other) => conflicts(item, other)) ||
          [...prepared.keys()].some((other) =>
            conflicts(item, selected[other]!),
          )
        )
          break;
        const check = this.remote.scan([
          ...new Set([
            item.change.path,
            item.change.localPath,
            item.change.remotePath,
          ]),
        ]);
        prepared.set(index, check);
        // Report a failure only if this file is actually started. Cancellation
        // of queued work must not produce unhandled promise rejections.
        void check.catch(() => {});
      }
    };
    try {
      if (selected.some((item) => item.action !== "skip"))
        this.remote.beginApply?.();
      while (
        next < selected.length &&
        !this.cancelled &&
        !executionFailed &&
        !persistenceFailed
      ) {
        const selection = selected[next]!;
        const transfer = [
          "upload",
          "download",
          "use-local",
          "use-remote",
        ].includes(selection.action);
        // Renames, trash, acceptance and skips are barriers. Dependent paths and
        // remote identities also run in order, even if their change keys differ.
        if (
          active.size &&
          (!transfer ||
            active.size >= limit ||
            [...active.values()].some((other) => conflicts(selection, other)))
        ) {
          if (active.size >= limit) prepareAhead();
          await Promise.race(active.keys());
          continue;
        }
        start(next++);
        if (!transfer) await Promise.all(active.keys());
      }
      await Promise.all(active.keys());
      if (executionFailed) throw executionError;
      if (this.cancelled) {
        await persist(() => {
          for (let index = next; index < selected.length; index++) {
            const { change: c, action } = selected[index]!;
            const op: Operation = {
              id: randomId(),
              session,
              at: Date.now(),
              context: review.context,
              remoteProfileId: review.profileId,
              remoteName: review.remoteName,
              path: c.path,
              action,
              status: "Cancelled",
              reason: "Not started; remains pending on next scan.",
              before: { local: c.local, remote: c.remote },
            };
            this.store.state.operations.push(op);
            results[index] = op;
          }
        });
      }
      return results;
    } finally {
      // Let outstanding reads settle before another Apply reuses this client.
      await Promise.allSettled(prepared.values());
      this.remote.endApply?.();
      onTransferProgress?.([]);
      this.busy = false;
    }
  }
}
