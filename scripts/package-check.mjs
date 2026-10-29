import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [pack] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
  }),
);
const files = pack.files.map((file) => file.path);
for (const file of [
  "dist/src/cli.js",
  "dist/src/index.js",
  "dist/src/index.d.ts",
  "README.md",
  "LICENSE",
  "SECURITY.md",
])
  assert.ok(files.includes(file), `Missing package file: ${file}`);
assert.ok(
  !files.some((file) =>
    /(^|\/)(tests|node_modules|oauth\.json|\.env)(\/|$)/.test(file),
  ),
  "Unexpected private/test package file",
);
console.log(
  `Package verified: ${files.length} files, ${pack.unpackedSize} unpacked bytes`,
);

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const server = JSON.parse(readFileSync("server.json", "utf8"));
assert.equal(server.name, manifest.mcpName);
assert.equal(
  server.repository.url,
  "https://github.com/HatoUP/scorekeeper-mcp",
);
assert.deepEqual(server.remotes, [
  { type: "streamable-http", url: "https://www.scorekeeper.co/api/mcp" },
]);
