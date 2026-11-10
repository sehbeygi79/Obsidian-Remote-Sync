/** Share identical reads queued before the next event-loop turn. Entries are removed
 * before I/O starts: a later verification can never join a pre-mutation read. */
export class ReadBatch<T> {
  private pending = new Map<string, Promise<T>>();
  run(key: string, read: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const result = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(
      () => {
        this.pending.delete(key);
        return read();
      },
    );
    this.pending.set(key, result);
    return result;
  }
}
