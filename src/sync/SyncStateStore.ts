import { checksum, randomId } from "../utils/hashing";
import type { DeviceState } from "./types";
import { localRoot, ROOT } from "../utils/paths";
import { IgnoreRules } from "../utils/IgnoreRules";
export interface PrivateStorage {
  read(path: string): Promise<string>;
  write(path: string, value: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
interface Slot {
  generation: number;
  checksum: string;
  payload: string;
}
export function freshState(): DeviceState {
  return {
    schema: 1,
    deviceId: randomId(),
    retentionDays: 90,
    baselines: {},
    seen: {},
    observations: [],
    operations: [],
    journal: [],
    localFolders: [ROOT],
    activeLocalFolder: ROOT,
    ignorePatterns: [],
  };
}
export class SyncStateStore {
  state = freshState();
  private generation = 0;
  private queue = Promise.resolve();
  private failed = false;
  constructor(
    private storage: PrivateStorage,
    private prefix: string,
  ) {}
  async load(): Promise<void> {
    const valid: { state: DeviceState; generation: number }[] = [];
    let present = false;
    for (const n of [0, 1]) {
      const path = `${this.prefix}.${n}.json`;
      if (!(await this.storage.exists(path))) continue;
      present = true;
      try {
        const slot = JSON.parse(await this.storage.read(path)) as Slot;
        if (
          checksum(slot.payload) !== slot.checksum ||
          !Number.isSafeInteger(slot.generation) ||
          slot.generation < 1
        )
          continue;
        const state = JSON.parse(slot.payload) as DeviceState;
        if (state.schema !== 1)
          throw new Error("Unsupported sync-state schema");
        if (
          !state.deviceId ||
          !state.baselines ||
          !Array.isArray(state.operations) ||
          !Array.isArray(state.observations) ||
          !Array.isArray(state.journal)
        )
          continue;
        state.seen ??= {}; // Additive v1 migration; never infer a confirmed state.
        state.localFolders ??= [ROOT];
        state.activeLocalFolder ??= ROOT;
        state.ignorePatterns ??= [];
        new IgnoreRules(state.ignorePatterns);
        if (
          !Array.isArray(state.localFolders) ||
          !state.localFolders.length ||
          state.localFolders.some(
            (folder) =>
              typeof folder !== "string" || localRoot(folder) !== folder,
          ) ||
          new Set(state.localFolders).size !== state.localFolders.length ||
          !state.localFolders.includes(state.activeLocalFolder)
        )
          throw new Error("Invalid local folder configuration");
        for (const records of Object.values(state.baselines)) {
          for (const [key, record] of Object.entries(records)) {
            if (
              record.key !== key ||
              typeof record.path !== "string" ||
              !Number.isFinite(record.syncedAt)
            )
              throw new Error("Invalid baseline identity");
          }
        }
        valid.push({ state, generation: slot.generation });
      } catch (e) {
        if (e instanceof Error && e.message === "Unsupported sync-state schema")
          throw e;
      }
    }
    if (present && !valid.length)
      throw new Error(
        "Sync metadata is corrupt. Restore private state from a device backup; do not infer deletions.",
      );
    const latest = valid.sort((a, b) => b.generation - a.generation)[0];
    if (latest) {
      this.state = latest.state;
      this.generation = latest.generation;
    }
  }
  save(): Promise<void> {
    if (this.failed)
      return Promise.reject(
        new Error(
          "State persistence failed. Reload Remote Sync before applying more operations.",
        ),
      );
    const payload = JSON.stringify(this.state);
    const run = this.queue.then(async () => {
      if (this.failed) throw new Error("State persistence unavailable");
      const generation = this.generation + 1,
        path = `${this.prefix}.${generation % 2}.json`;
      const slot: Slot = { generation, payload, checksum: checksum(payload) };
      await this.storage.write(path, JSON.stringify(slot));
      if ((await this.storage.read(path)) !== JSON.stringify(slot))
        throw new Error("State persistence verification failed");
      this.generation = generation;
    });
    this.queue = run.catch(() => {
      this.failed = true;
    });
    return run;
  }
  prune(now = Date.now()): void {
    const cutoff = now - this.state.retentionDays * 86400000;
    this.state.observations = this.state.observations.filter(
      (o) => o.at >= cutoff,
    );
    this.state.operations = this.state.operations.filter((o) => o.at >= cutoff);
    // Never prune confirmed baselines or unresolved journal entries.
  }
}
