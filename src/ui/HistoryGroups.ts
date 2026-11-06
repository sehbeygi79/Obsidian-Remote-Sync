import type { Operation, Status } from "../sync/types";

export interface SyncCommit {
  key: string;
  session: string;
  context: string;
  startedAt: number;
  finishedAt?: number;
  operations: Operation[];
  unresolved: Set<string>;
  counts: Record<Status, number>;
}

/** Group existing records without rewriting history or double-counting journals. */
export function syncCommits(
  operations: Operation[],
  journal: Operation[] = [],
): SyncCommit[] {
  const records = new Map<string, Operation>();
  const unresolved = new Set(journal.map((operation) => operation.id));
  for (const operation of [...journal, ...operations])
    records.set(operation.id, operation);
  const groups = new Map<string, SyncCommit>();
  for (const operation of records.values()) {
    const session = operation.session || operation.id;
    const key = JSON.stringify([operation.context, session]);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        session,
        context: operation.context,
        startedAt: operation.at,
        operations: [],
        unresolved: new Set(),
        counts: {
          Running: 0,
          Success: 0,
          Failed: 0,
          "Needs Rescan": 0,
          Skipped: 0,
          Cancelled: 0,
        },
      };
      groups.set(key, group);
    }
    group.operations.push(operation);
    group.counts[operation.status]++;
    group.startedAt = Math.min(group.startedAt, operation.at);
    if (unresolved.has(operation.id)) group.unresolved.add(operation.id);
  }
  for (const group of groups.values()) {
    group.operations.sort(
      (a, b) => a.at - b.at || a.path.localeCompare(b.path),
    );
    if (!group.unresolved.size && !group.counts.Running)
      group.finishedAt = Math.max(
        ...group.operations.map(
          (operation) => operation.finishedAt ?? operation.at,
        ),
      );
  }
  return [...groups.values()].sort(
    (a, b) => b.startedAt - a.startedAt || a.key.localeCompare(b.key),
  );
}

export function matchesFile(operation: Operation, query: string): boolean {
  const term = query.trim().toLocaleLowerCase();
  return (
    !term ||
    [
      operation.path,
      operation.before.local?.path,
      operation.before.remote?.path,
      operation.after?.local?.path,
      operation.after?.remote?.path,
    ].some((path) => path?.toLocaleLowerCase().includes(term))
  );
}
