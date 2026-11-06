import { checksum } from "../utils/hashing";
import { parseEnvelope, type Envelope } from "./CredentialEncryption";
import type { PrivateStorage } from "../sync/SyncStateStore";
interface ConfigSlot {
  generation: number;
  payload: string;
  checksum: string;
}
export class EncryptedConfig {
  private generation = 0;
  constructor(
    private storage: PrivateStorage,
    private prefix: string,
  ) {}
  async load(): Promise<Envelope | null> {
    const slots: ConfigSlot[] = [];
    let present = false;
    for (const n of [0, 1]) {
      const p = `${this.prefix}.${n}.json`;
      if (!(await this.storage.exists(p))) continue;
      present = true;
      try {
        const s = JSON.parse(await this.storage.read(p)) as ConfigSlot;
        if (
          Number.isSafeInteger(s.generation) &&
          s.generation > 0 &&
          checksum(s.payload) === s.checksum
        ) {
          if (s.payload !== "null") parseEnvelope(s.payload);
          slots.push(s);
        }
      } catch {
        /* Validate the other committed slot. */
      }
    }
    slots.sort((a, b) => b.generation - a.generation);
    if (present && !slots.length)
      throw new Error(
        "Encrypted configuration is damaged. Reimport an exported bundle.",
      );
    if (!slots[0]) return null;
    this.generation = slots[0].generation;
    return slots[0].payload === "null" ? null : parseEnvelope(slots[0].payload);
  }
  async save(envelope: Envelope | null): Promise<void> {
    const payload = JSON.stringify(envelope),
      next = this.generation + 1;
    const text = JSON.stringify({
      generation: next,
      payload,
      checksum: checksum(payload),
    });
    // Verify first commit, then replace the previous encrypted slot too. This avoids retaining an old passphrase envelope.
    for (const n of [next % 2, (next + 1) % 2]) {
      const path = `${this.prefix}.${n}.json`;
      await this.storage.write(path, text);
      if ((await this.storage.read(path)) !== text)
        throw new Error("Credential persistence verification failed");
    }
    this.generation = next;
  }
}
