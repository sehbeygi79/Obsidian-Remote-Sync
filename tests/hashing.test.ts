import { describe, expect, it, vi } from "vitest";
import { contentHashes, hashes } from "../src/utils/hashing";
import { sameVersion } from "../src/sync/ReconciliationEngine";
import { bytes, file } from "./helpers";

describe("asynchronous content hashing", () => {
  it.each([0, 17, 2 * 1024 * 1024 + 37])(
    "matches verified digests for %s bytes and omits unneeded MD5",
    async (length) => {
      const data = new Uint8Array(length);
      for (let i = 0; i < length; i++) data[i] = i % 251;
      const expected = hashes(data.buffer);
      expect(await contentHashes(data.buffer)).toEqual({
        sha256: expected.sha256,
      });
      expect(await contentHashes(data.buffer, true)).toEqual(expected);
    },
  );
  it("uses native SHA-256", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      const data = new ArrayBuffer(128 * 1024);
      expect((await contentHashes(data)).sha256).toBe(hashes(data).sha256);
      expect(digest).toHaveBeenCalledWith("SHA-256", data);
    } finally {
      digest.mockRestore();
    }
  });
  it("falls back portably and allows timer/network callbacks to run during large hashes", async () => {
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValue(new Error("Native crypto unavailable"));
    try {
      const data = new ArrayBuffer(3 * 1024 * 1024);
      const expected = hashes(data);
      let completed = false;
      const task = contentHashes(data, true).then((result) => {
        completed = true;
        return result;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(completed).toBe(false);
      expect(await task).toEqual(expected);
    } finally {
      digest.mockRestore();
    }
  });
  it("matches legacy records through a common digest without ignoring version or content changes", () => {
    const original = file();
    const shaOnly = { ...original, hashes: { sha256: original.hashes.sha256 } };
    const md5Only = { ...original, hashes: { md5: original.hashes.md5 } };
    expect(sameVersion(original, shaOnly)).toBe(true);
    expect(sameVersion(original, md5Only)).toBe(true);
    expect(sameVersion(shaOnly, md5Only)).toBe(false);
    expect(sameVersion(original, { ...shaOnly, modifiedAt: 1001 })).toBe(false);
    expect(sameVersion(original, { ...shaOnly, localId: "replacement" })).toBe(
      false,
    );
    expect(
      sameVersion(original, { ...shaOnly, hashes: hashes(bytes("different")) }),
    ).toBe(false);
    expect(sameVersion(original, null)).toBe(false);
    expect(sameVersion(null, undefined)).toBe(true);
  });
});

it("limits compatibility hashing to relevant files while retaining MD5-only rename candidates", async () => {
  const { legacyHashPaths } = await import("../src/sync/ReconciliationEngine");
  const { snapshot, baseline } = await import("./helpers");
  const local = snapshot([
    file("modern", "modern"),
    file("legacy", "old"),
    file("unrelated-video", "video"),
  ]);
  const remoteLegacy = file("legacy", "old", true);
  delete remoteLegacy.hashes.sha256;
  expect(legacyHashPaths(local, snapshot([remoteLegacy]), {})).toEqual([
    "legacy",
  ]);
  const old = baseline("before", "same");
  const renamed = snapshot([
    file("after", "same"),
    file("unrelated-video", "video"),
  ]);
  const remoteOld = file("before", "same", true);
  delete remoteOld.hashes.sha256;
  expect(
    legacyHashPaths(renamed, snapshot([remoteOld]), { before: old }),
  ).toEqual(["after"]);
  old.hash = { md5: old.hash!.md5 };
  expect(
    legacyHashPaths(renamed, snapshot([remoteOld]), { before: old }).sort(),
  ).toEqual(["after", "unrelated-video"]);
});
