import { context } from "esbuild";
import { cp, mkdir, readFile } from "node:fs/promises";
const ctx = await context({
  banner: {
    js: `/*!\n${await readFile("LICENSE", "utf8")}\nThird-party: @noble/hashes\n${await readFile("node_modules/@noble/hashes/LICENSE", "utf8")}\n*/`,
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "node:fs/promises", "node:path", "node:http"],
  format: "cjs",
  platform: "browser",
  target: "es2022",
  outfile: "main.js",
  minify: !process.argv.includes("--watch"),
});
if (process.argv.includes("--watch")) await ctx.watch();
else {
  await ctx.rebuild();
  await ctx.dispose();
  await mkdir("obsidian-remote-sync", { recursive: true });
  for (const f of ["main.js", "manifest.json", "styles.css"])
    await cp(f, `obsidian-remote-sync/${f}`);
}
