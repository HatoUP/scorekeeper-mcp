import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("hooks check isolated staged and every outgoing tip, propagate failure, and clean snapshots", () => {
  const fixture = mkdtempSync(join(tmpdir(), "scorekeeper-hooks-"));
  const repo = join(fixture, "repo"),
    bin = join(fixture, "bin"),
    log = join(fixture, "calls");
  mkdirSync(repo);
  mkdirSync(bin);
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  try {
    run("init", "-q");
    run("config", "user.name", "Hook Fixture");
    run("config", "user.email", "fixture@example.invalid");
    mkdirSync(join(repo, "scripts"));
    copyFileSync(
      new URL("../../scripts/git-check.mjs", import.meta.url),
      join(repo, "scripts/git-check.mjs"),
    );
    writeFileSync(join(repo, "value"), "staged");
    run("add", ".");
    run("commit", "-qm", "one");
    const first = run("rev-parse", "HEAD");
    writeFileSync(join(repo, "value"), "second");
    run("add", ".");
    run("commit", "-qm", "two");
    const second = run("rev-parse", "HEAD");
    writeFileSync(join(repo, "value"), "unstaged");
    writeFileSync(
      join(bin, "npm"),
      '#!/bin/sh\nprintf "%s:%s\\n" "$PWD" "$*" >> "$HOOK_LOG"\n[ "$(cat value)" != unstaged ] || exit 9\n[ "$HOOK_FAIL" != yes ]\n',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOOK_LOG: log,
    };
    const invoke = (mode: string, input = "", fail = false) =>
      spawnSync(process.execPath, ["scripts/git-check.mjs", mode], {
        cwd: repo,
        env: { ...env, HOOK_FAIL: fail ? "yes" : "no" },
        input,
        encoding: "utf8",
      });
    assert.equal(invoke("staged").status, 0);
    assert.equal(
      invoke(
        "push",
        `refs/heads/main ${second} refs/heads/main ${"0".repeat(40)}\n`,
      ).status,
      0,
    );
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(lines.length, 9); // Three fresh commands for staged + both outgoing commits.
    for (const line of lines)
      assert.throws(() => readFileSync(join(line.split(":")[0], "value")));
    assert.notEqual(invoke("staged", "", true).status, 0);
    assert.equal(
      invoke("push", `refs/heads/main ${second} refs/heads/main ${first}\n`)
        .status,
      0,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
