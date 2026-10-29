import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "../src/constants.js";
const cli = new URL("../src/cli.js", import.meta.url);
test("version is explicit; unknown options never start another transport", () => {
  const version = spawnSync(process.execPath, [cli.pathname, "--version"], {
    encoding: "utf8",
  });
  assert.equal(version.status, 0);
  assert.equal(version.stdout, `${VERSION}\n`);
  assert.equal(version.stderr, "");
  const invalid = spawnSync(
    process.execPath,
    [cli.pathname, "serve", "--url=https://untrusted.invalid"],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Usage:/);
});
test("actual stdio process initializes without credentials or upstream network and keeps stdout protocol-only", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "scorekeeper-cli-"));
  const client = new Client(
    { name: "stdio-smoke", version: "1" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli.pathname, "serve"],
    env: { PATH: process.env.PATH ?? "", SCOREKEEPER_CONFIG_DIR: fixtureDir },
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk) => {
    diagnostics += String(chunk);
  });
  try {
    await client.connect(transport, { timeout: 5000 });
    assert.equal(client.getServerVersion()?.name, "scorekeeper-stdio");
    assert.deepEqual(client.getServerCapabilities()?.tools, {
      listChanged: true,
    });
    await client.ping();
    assert.equal(diagnostics, "");
  } finally {
    await client.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("package version and registry identity match the executable", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.mcpName, "co.scorekeeper/scorekeeper");
  assert.equal(manifest.author.name, "Stormlight Ventures LLC");
});
