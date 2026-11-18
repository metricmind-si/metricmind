import { gzipSync } from "node:zlib";

// mm.js is on every page; survey.js loads only when a live survey is due.
for (const [entry, name] of [["./src/index.ts", "mm.js"], ["./src/survey-entry.ts", "survey.js"]] as const) {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: "./dist",
    naming: name,
    target: "browser",
    format: "iife",
    minify: true,
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  const bytes = await Bun.file(`./dist/${name}`).bytes();
  console.log(`dist/${name}  ${(bytes.length / 1024).toFixed(1)} KB, ${(gzipSync(bytes).length / 1024).toFixed(1)} KB gzip`);
}
