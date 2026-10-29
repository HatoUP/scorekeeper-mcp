#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAuthContext, login, logout, status } from "./auth.js";
import { createScorekeeperBridge } from "./core.js";
import { VERSION } from "./constants.js";

function usage() {
  process.stderr.write(
    "Usage: scorekeeper-mcp [serve | login [--billing] [--no-browser] | status | logout | --version]\n",
  );
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command = "serve", ...flags] = args;
  if (command === "--version" && !flags.length) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if ((command === "--help" || command === "help") && !flags.length) {
    usage();
    return;
  }
  if (
    command === "login" &&
    flags.every((f) => f === "--billing" || f === "--no-browser") &&
    new Set(flags).size === flags.length
  ) {
    const value = await login({
      billing: flags.includes("--billing"),
      openBrowser: !flags.includes("--no-browser"),
    });
    process.stderr.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (command === "status" && !flags.length) {
    process.stderr.write(`${JSON.stringify(await status())}\n`);
    return;
  }
  if (command === "logout" && !flags.length) {
    process.stderr.write(`${JSON.stringify(await logout())}\n`);
    return;
  }
  if (command !== "serve" || flags.length) {
    usage();
    process.exitCode = 2;
    return;
  }
  const bridge = createScorekeeperBridge(await createAuthContext());
  const shutdown = () => {
    void bridge.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  await bridge.server.connect(new StdioServerTransport());
}
void main().catch(() => {
  // OAuth/network exceptions may contain credentials. Never print them.
  process.stderr.write(
    "Scorekeeper bridge could not complete the request. Check the connection with scorekeeper-mcp status or reconnect with scorekeeper-mcp login.\n",
  );
  process.exitCode = 1;
});
