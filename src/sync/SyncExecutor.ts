import { affected, relative } from "../utils/paths";
import { hashes, randomId } from "../utils/hashing";
import { equal, fingerprint } from "./ReconciliationEngine";
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
  }
  private async snapshots(): Promise<{ local: Snapshot; remote: Snapshot }> {
    const local = await this.local.scan();
    const remote = await this.remote.scan();
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
        fingerprint(current.local.files[p]) !==
          fingerprint(review.local.files[p]) ||
        fingerprint(current.remote.files[p]) !==
          fingerprint(review.remote.files[p])
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
    onTransferProgress?: (progress: TransferProgress | null) => void,
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
    const results: Operation[] = [],
      session = randomId();
    try {
      for (const [index, { change: c, action }] of selected.entries()) {
        if (this.cancelled) break;
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
        results.push(op);
        onTransferProgress?.(null);
        if (action === "skip") {
          op.status = "Skipped";
          op.finishedAt = Date.now();
          this.store.state.operations.push(op);
          await this.store.save();
          onProgress?.(op, index + 1, selected.length);
          continue;
        }
        let journaled = false;
        try {
          const current = await this.snapshots();
          this.validate(review, c, current);
          if (c.category === "blocked")
            throw new Error("Needs Rescan: unsupported path");
          if (action === "upload" && !c.remote)
            op.remoteId = await this.remote.reserveId();
          this.store.state.journal.push(op);
          journaled = true;
          await this.store.save();
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
            onTransferProgress?.({ ...transfer });
            const bytes = await this.local.read(c.local.path);
            if (
              !equal(c.local, {
                ...c.local,
                size: bytes.byteLength,
                hashes: hashes(bytes),
              })
            )
              throw new Error("Needs Rescan: upload source changed");
            // Transfer preparation can take time; revalidate again before touching destination.
            this.validate(review, c, await this.snapshots());
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
                    onTransferProgress({ ...transfer });
                  }
                : undefined,
            );
            onTransferProgress?.({
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
            onTransferProgress?.({ ...transfer });
            const bytes = await this.remote.read(
              c.remote,
              onTransferProgress
                ? (transferred, total) => {
                    Object.assign(transfer, {
                      transferred,
                      total,
                      phase: "transferring",
                    });
                    onTransferProgress({ ...transfer });
                  }
                : undefined,
            );
            onTransferProgress?.({
              ...transfer,
              transferred: bytes.byteLength,
              phase: "verifying",
            });
            if (
              !equal(c.remote, {
                ...c.remote,
                size: bytes.byteLength,
                hashes: hashes(bytes),
              })
            )
              throw new Error(
                "Needs Rescan: downloaded content differs from preview",
              );
            this.validate(review, c, await this.snapshots());
            await this.local.write(c.remote.path, bytes, c.local);
            resultingPath = c.remote.path;
          } else if (action === "trash-local") {
            if (!c.local) throw new Error("Missing local file");
            await this.local.trash(c.local.path, c.local);
            resultingPath = c.local.path;
          } else if (action === "trash-remote") {
            if (!c.remote) throw new Error("Missing remote file");
            await this.remote.trash(c.remote);
            resultingPath = c.remote.path;
          } else if (action === "local-path") {
            if (!c.local || !c.remote) throw new Error("Missing rename source");
            if (current.remote.files[c.local.path])
              throw new Error(
                "Needs Rescan: remote rename destination occupied",
              );
            await this.remote.rename(c.remote, c.local.path);
            resultingPath = c.local.path;
          } else if (action === "remote-path") {
            if (!c.local || !c.remote) throw new Error("Missing rename source");
            if (current.local.files[c.remote.path])
              throw new Error(
                "Needs Rescan: local rename destination occupied",
              );
            await this.local.rename(c.local.path, c.remote.path, c.local);
            resultingPath = c.remote.path;
          }
          const after = await this.snapshots();
          if (
            !this.reviewValid() ||
            this.context() !== review.context ||
            after.remote.identity !== review.remote.identity
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
            const oldPath =
              action === "local-path" ? c.remotePath : c.localPath;
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
            if (fingerprint(l) !== fingerprint(c.local) || !equal(r, c.local))
              throw new Error("Needs Rescan: source changed during upload");
          } else if (action === "download" || action === "use-remote") {
            if (fingerprint(r) !== fingerprint(c.remote) || !equal(l, c.remote))
              throw new Error("Needs Rescan: source changed during download");
          } else if (action === "accept") {
            if (
              fingerprint(l) !== fingerprint(c.local) ||
              fingerprint(r) !== fingerprint(c.remote)
            )
              throw new Error("Needs Rescan: equality acceptance changed");
          }
          const checkpoint = structuredClone(this.store.state);
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
          try {
            await this.store.save();
          } catch (e) {
            this.store.state = checkpoint;
            throw e;
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : "Operation failed";
          op.status = message.includes("Needs Rescan")
            ? "Needs Rescan"
            : "Failed";
          // Persist fixed diagnostics, never raw HTTP bodies, tokens or file contents.
          op.reason =
            op.status === "Needs Rescan"
              ? "Reviewed source, destination or identity changed; review a fresh scan."
              : "Operation or verification failed. Inspect both sides and rescan; no automatic retry.";
          op.finishedAt = Date.now();
          this.store.state.operations.push(op);
          if (!journaled)
            this.store.state.journal = this.store.state.journal.filter(
              (j) => j.id !== op.id,
            );
          await this.store.save();
        }
        onTransferProgress?.(null);
        onProgress?.(op, index + 1, selected.length);
      }
      if (this.cancelled) {
        for (const { change: c, action } of selected.slice(results.length)) {
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
          results.push(op);
        }
        await this.store.save();
      }
      return results;
    } finally {
      onTransferProgress?.(null);
      this.busy = false;
    }
  }
}
