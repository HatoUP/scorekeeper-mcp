import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (
  realpathSync(git("rev-parse", "--show-toplevel")) !==
  realpathSync(process.cwd())
)
  throw new Error(
    "Refusing to check a parent repository; initialize this standalone repository first",
  );
const mode = process.argv[2];
if (!["staged", "push"].includes(mode)) throw new Error("Unknown check mode");
const refs = new Set();
if (mode === "staged") refs.add(git("write-tree"));
else {
  for (const line of readFileSync(0, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)) {
    const [, local, , remote] = line.split(/\s+/);
    if (/^0+$/.test(local)) continue;
    // Check every outgoing commit, including all history on a first push.
    const range = /^0+$/.test(remote)
      ? [local, "--not", "--remotes"]
      : [`${remote}..${local}`];
    for (const ref of git("rev-list", ...range)
      .split("\n")
      .filter(Boolean))
      refs.add(ref);
  }
}
for (const ref of refs) {
  const dir = mkdtempSync(join(tmpdir(), "scorekeeper-git-check-"));
  try {
    console.error(`Checking isolated ${mode} snapshot ${ref}`);
    const archive = execFileSync("git", ["archive", ref], {
      maxBuffer: 32 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", dir], { input: archive });
    for (const args of [
      ["ci", "--ignore-scripts"],
      ["run", "check"],
      ["run", "package:check"],
    ]) {
      const result = spawnSync("npm", args, { cwd: dir, stdio: "inherit" });
      if (result.status !== 0)
        throw new Error(`Fresh ${args.join(" ")} failed`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
