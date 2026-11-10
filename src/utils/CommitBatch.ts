/** Group ready state mutations into one durable transaction. Each caller waits
 * for its entire group to commit; another group cannot mutate state mid-save. */
export class CommitBatch {
  private pending: {
    mutate: () => void;
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  private running = false;
  constructor(private commit: (mutations: (() => void)[]) => Promise<void>) {}
  run(mutate: () => void): Promise<void> {
    const result = new Promise<void>((resolve, reject) => {
      this.pending.push({ mutate, resolve, reject });
    });
    if (!this.running) {
      this.running = true;
      void this.flush();
    }
    return result;
  }
  private async flush(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      try {
        await this.commit(batch.map((item) => item.mutate));
        for (const item of batch) item.resolve();
      } catch (error) {
        for (const item of batch) item.reject(error);
      }
      // Let newly ready completions join the next transaction without a timer.
      await Promise.resolve();
    }
    this.running = false;
  }
}
