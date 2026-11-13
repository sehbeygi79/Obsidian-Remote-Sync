import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { Script, createContext } from "node:vm";
import { webcrypto } from "node:crypto";
const code = await readFile("obsidian-remote-sync/main.js", "utf8");
const imports = [];
const paths = [];
const files = new Map();
const host = {
  Plugin: class {},
  PluginSettingTab: class {
    containerEl = { isConnected: false };
  },
  Modal: class {},
  Setting: class {},
  Notice: class {},
  TFile: class {},
  FileSystemAdapter: class {},
  Platform: { isDesktopApp: false, isAndroidApp: true, isMobile: true },
  requestUrl: () => {
    throw new Error("Unexpected startup network request");
  },
};
const context = createContext({
  module: { exports: {} },
  require: (name) => {
    imports.push(name);
    if (name !== "obsidian") throw new Error(`Mobile tried loading ${name}`);
    return host;
  },
  crypto: webcrypto,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  AbortController,
  Uint8Array,
  ArrayBuffer,
  DataView,
  atob,
  btoa,
  structuredClone,
});
new Script(code, { filename: "main.js" }).runInContext(context);
const plugin = new context.module.exports.default();
plugin.manifest = {
  id: "obsidian-remote-sync",
  name: "Remote Sync",
  version: "1.5.0",
  dir: ".obsidian/plugins/obsidian-remote-sync",
};
plugin.app = {
  vault: {
    configDir: ".obsidian",
    adapter: {
      exists: async (p) => files.has(p),
      mkdir: async (p) => {
        paths.push(p);
        files.set(p, "");
      },
      read: async (p) => files.get(p),
      write: async (p, v) => {
        paths.push(p);
        files.set(p, v);
      },
    },
  },
};
const registered = [];
for (const method of ["addRibbonIcon", "addCommand", "addSettingTab"])
  plugin[method] = (...args) => {
    registered.push(args);
  };
await plugin.onload();
assert.equal(plugin.credentials.unlocked, false);
assert.equal(plugin.executor, null);
assert(imports.every((name) => name === "obsidian"));
assert(
  paths.every((p) =>
    p.startsWith(".obsidian/plugins/obsidian-remote-sync/private"),
  ),
);
assert(registered.some((args) => args[1] === "Remote Sync"));
assert(registered.some((args) => args[0]?.name === "Review Status"));
plugin.onunload();
console.log(
  "Production bundle smoke check passed: mobile load/unload, no Node modules or network, private storage only.",
);
