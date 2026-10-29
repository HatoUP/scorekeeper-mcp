import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const image = process.argv[2];
assert.ok(image, "Pass the local container image tag");
const client = new Client(
  { name: "container-smoke", version: "1" },
  { capabilities: {} },
);
try {
  await client.connect(
    new StdioClientTransport({
      command: "docker",
      args: ["run", "--rm", "-i", "--network=none", image],
      stderr: "inherit",
    }),
    { timeout: 15000 },
  );
  assert.equal(client.getServerVersion()?.name, "scorekeeper-stdio");
  await client.ping();
} finally {
  await client.close();
}
