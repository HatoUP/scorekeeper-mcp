import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
if (
  process.argv.includes("--prepare") &&
  (process.env.npm_config_ignore_scripts === "true" || !existsSync(".git"))
)
  process.exit(0);
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
if (realpathSync(root) !== realpathSync(process.cwd()))
  throw new Error(
    "Initialize this standalone repository before installing its hooks",
  );
execFileSync("git", ["config", "core.hooksPath", ".githooks"]);
