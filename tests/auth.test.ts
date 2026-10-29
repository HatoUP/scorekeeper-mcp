import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { createAuthContext, login, logout, status } from "../src/auth.js";

const TOKEN = "a".repeat(43),
  REFRESH = "b".repeat(43),
  ROTATED = "c".repeat(43),
  CLIENT = "d".repeat(43);
const ORIGIN = "https://www.scorekeeper.co",
  RESOURCE = ORIGIN + "/api/mcp";
async function isolated(run: (dir: string) => Promise<void>) {
  const root = await fs.mkdtemp(join(tmpdir(), "scorekeeper-auth-")),
    dir = join(root, "credentials");
  const previous = process.env.SCOREKEEPER_CONFIG_DIR,
    envToken = process.env.SCOREKEEPER_ACCESS_TOKEN;
  process.env.SCOREKEEPER_CONFIG_DIR = dir;
  delete process.env.SCOREKEEPER_ACCESS_TOKEN;
  try {
    await run(dir);
  } finally {
    if (previous === undefined) delete process.env.SCOREKEEPER_CONFIG_DIR;
    else process.env.SCOREKEEPER_CONFIG_DIR = previous;
    if (envToken === undefined) delete process.env.SCOREKEEPER_ACCESS_TOKEN;
    else process.env.SCOREKEEPER_ACCESS_TOKEN = envToken;
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function seed(dir: string, patch: Record<string, unknown> = {}) {
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(
    join(dir, "oauth.json"),
    JSON.stringify({
      client: { client_id: CLIENT, issuer: ORIGIN },
      redirect: "http://127.0.0.1:43210/callback",
      scopes: ["scoreboards:read", "scoreboards:write"],
      tokens: {
        access_token: TOKEN,
        refresh_token: REFRESH,
        token_type: "Bearer",
        issuer: ORIGIN,
      },
      expiresAt: Date.now() + 3600000,
      ...patch,
    }),
    { mode: 0o600 },
  );
}
function callback(
  url: URL,
  method = "GET",
  host?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method, headers: host ? { Host: host } : {} },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += String(c)));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
test("empty auth is credential-free and never creates local files or registers", async () =>
  isolated(async (dir) => {
    const context = await createAuthContext();
    assert.equal(await context.hasCredentials(), false);
    assert.equal((await status()).source, "none");
    await assert.rejects(
      async () => context.provider.clientInformation(),
      /Authentication unavailable/,
    );
    await assert.rejects(fs.stat(dir), { code: "ENOENT" });
  }));
test("environment bearer is never persisted, echoed, refreshed or browser-authorized", async () =>
  isolated(async (dir) => {
    process.env.SCOREKEEPER_ACCESS_TOKEN = TOKEN;
    const context = await createAuthContext();
    assert.equal(await context.hasCredentials(), true);
    assert.equal((await context.provider.tokens())?.access_token, TOKEN);
    assert.equal((await status()).source, "environment");
    assert.ok(!JSON.stringify(await status()).includes(TOKEN));
    await assert.rejects(
      async () => context.provider.clientInformation(),
      /Authentication unavailable/,
    );
    await assert.rejects(
      async () =>
        context.provider.redirectToAuthorization(
          new URL(ORIGIN + "/agents/connect"),
        ),
      /Authentication unavailable/,
    );
    await assert.rejects(fs.stat(dir), { code: "ENOENT" });
  }));
test("credential files and directories reject unsafe permissions and symlinks", async () =>
  isolated(async (dir) => {
    await seed(dir);
    await fs.chmod(join(dir, "oauth.json"), 0o644);
    await assert.rejects(status(), /Authentication unavailable/);
    await fs.chmod(join(dir, "oauth.json"), 0o600);
    await fs.chmod(dir, 0o755);
    await assert.rejects(status(), /Authentication unavailable/);
    await fs.chmod(dir, 0o700);
    const target = join(dir, "other.json");
    await fs.rename(join(dir, "oauth.json"), target);
    await fs.symlink(target, join(dir, "oauth.json"));
    await assert.rejects(status(), /Authentication unavailable/);
    await fs.unlink(join(dir, "oauth.json"));
    await fs.rename(dir, dir + "-real");
    await fs.symlink(dir + "-real", dir);
    await assert.rejects(status(), /Authentication unavailable/);
  }));
test("SDK refresh persists rotation atomically and binds resource and issuer", async (t) =>
  isolated(async (dir) => {
    await seed(dir, { expiresAt: 1 });
    const context = await createAuthContext();
    let calls = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        assert.equal(String(input), ORIGIN + "/api/agents/oauth/token");
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("refresh_token"), REFRESH);
        assert.equal(body.get("client_id"), CLIENT);
        assert.equal(body.get("resource"), RESOURCE);
        calls++;
        return Response.json({
          access_token: ROTATED,
          refresh_token: ROTATED,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "scoreboards:read scoreboards:write",
        });
      },
    );
    assert.equal(
      await auth(context.provider, {
        serverUrl: RESOURCE,
        scope: "scoreboards:read scoreboards:write",
      }),
      "AUTHORIZED",
    );
    assert.equal(calls, 1);
    assert.equal((await context.provider.tokens())?.refresh_token, ROTATED);
    const saved = JSON.parse(
      await fs.readFile(join(dir, "oauth.json"), "utf8"),
    );
    assert.equal(saved.tokens.refresh_token, ROTATED);
    assert.equal((await fs.stat(join(dir, "oauth.json"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    assert.deepEqual(await fs.readdir(dir), ["oauth.json"]);
    assert.ok(!JSON.stringify(await status()).includes(ROTATED));
  }));
test("explicit login uses PKCE, exact loopback registration and state; rejects wrong callback requests", async (t) =>
  isolated(async (dir) => {
    let authorization: URL | undefined,
      printed = "",
      registered: string | undefined,
      verifier = "",
      callbackWork: Promise<void> | undefined;
    t.mock.method(process.stderr, "write", ((chunk: string | Uint8Array) => {
      printed += String(chunk);
      const line = String(chunk)
        .split("\n")
        .find((s) => s.startsWith(ORIGIN + "/agents/connect?"));
      if (line) {
        authorization = new URL(line);
        callbackWork = (async () => {
          const target = new URL(
            authorization!.searchParams.get("redirect_uri")!,
          );
          assert.equal(target.hostname, "127.0.0.1");
          assert.equal(target.href, registered);
          const good = new URL(target);
          good.searchParams.set("code", "demo-code-secret");
          good.searchParams.set(
            "state",
            authorization!.searchParams.get("state")!,
          );
          const wrong = new URL(good);
          wrong.searchParams.set("state", "wrong");
          assert.equal((await callback(wrong)).status, 400);
          assert.equal((await callback(good, "POST")).status, 400);
          assert.equal(
            (await callback(good, "GET", "evil.example")).status,
            400,
          );
          const other = new URL(good);
          other.pathname = "/wrong";
          assert.equal((await callback(other)).status, 400);
          const unicode = new URL(good);
          unicode.searchParams.set("state", "é".repeat(43));
          assert.equal((await callback(unicode)).status, 400);
          const result = await callback(good);
          assert.equal(result.status, 200);
          assert.ok(!result.body.includes("demo-code-secret"));
        })();
      }
      return true;
    }) as typeof process.stderr.write);
    t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        assert.ok(url.startsWith(ORIGIN + "/api/agents/oauth/"));
        if (url.endsWith("/register")) {
          const body = JSON.parse(String(init?.body));
          registered = body.redirect_uris[0];
          assert.equal(body.token_endpoint_auth_method, "none");
          assert.equal(
            body.scope,
            "scoreboards:read scoreboards:write billing:read billing:checkout",
          );
          return Response.json({ ...body, client_id: CLIENT });
        }
        assert.equal(url, ORIGIN + "/api/agents/oauth/token");
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("code"), "demo-code-secret");
        assert.equal(body.get("redirect_uri"), registered);
        assert.equal(body.get("resource"), RESOURCE);
        verifier = body.get("code_verifier")!;
        assert.equal(
          createHash("sha256").update(verifier).digest("base64url"),
          authorization!.searchParams.get("code_challenge"),
        );
        return Response.json({
          access_token: TOKEN,
          refresh_token: REFRESH,
          token_type: "Bearer",
          expires_in: 3600,
          scope:
            "scoreboards:read scoreboards:write billing:read billing:checkout",
        });
      },
    );
    const result = await login({
      billing: true,
      openBrowser: false,
      timeoutMs: 5000,
    });
    await callbackWork;
    assert.equal(result.authenticated, true);
    assert.equal(result.scopes.length, 4);
    assert.ok(
      !printed.includes(TOKEN) &&
        !printed.includes(REFRESH) &&
        !printed.includes(verifier) &&
        !printed.includes("demo-code-secret"),
    );
    assert.equal((await fs.stat(join(dir, "oauth.json"))).mode & 0o777, 0o600);
  }));
test("abandoned explicit login times out without storing partial registration or secrets", async (t) =>
  isolated(async (dir) => {
    t.mock.method(
      process.stderr,
      "write",
      (() => true) as typeof process.stderr.write,
    );
    t.mock.method(
      globalThis,
      "fetch",
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        Response.json({ ...JSON.parse(String(init?.body)), client_id: CLIENT }),
    );
    const started = Date.now();
    await assert.rejects(
      login({ openBrowser: false, timeoutMs: 100 }),
      /Authentication unavailable/,
    );
    assert.ok(
      Date.now() - started >= 90,
      "Must exercise the actual callback deadline",
    );
    await assert.rejects(fs.stat(dir), { code: "ENOENT" });
  }));
test("logout revokes only own refresh grant with matching client and removes only own state", async (t) =>
  isolated(async (dir) => {
    await seed(dir);
    await fs.writeFile(join(dir, "keep.txt"), "preserve");
    let called = false;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        assert.equal(String(input), ORIGIN + "/api/agents/oauth/revoke");
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("token"), REFRESH);
        assert.equal(body.get("client_id"), CLIENT);
        called = true;
        return Response.json({});
      },
    );
    assert.deepEqual(await logout(), {
      loggedOut: true,
      remoteRevoked: true,
      environmentTokenStillSet: false,
    });
    assert.equal(called, true);
    assert.equal(await fs.readFile(join(dir, "keep.txt"), "utf8"), "preserve");
    assert.equal((await status()).authenticated, false);
  }));

test("malformed local tokens fail with a redacted error", async () =>
  isolated(async (dir) => {
    await seed(dir, { tokens: { access_token: TOKEN, refresh_token: 42 } });
    await assert.rejects(status(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Authentication unavailable/);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
  }));
test("hard-linked credentials are refused", async () =>
  isolated(async (dir) => {
    await seed(dir);
    await fs.link(join(dir, "oauth.json"), join(dir, "copy.json"));
    await assert.rejects(status(), /Authentication unavailable/);
  }));
test("offline logout clears local credentials and preserves environment bearer", async (t) =>
  isolated(async (dir) => {
    await seed(dir);
    process.env.SCOREKEEPER_ACCESS_TOKEN = TOKEN;
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("offline");
    });
    assert.deepEqual(await logout(), {
      loggedOut: true,
      remoteRevoked: false,
      environmentTokenStillSet: true,
    });
    await assert.rejects(fs.stat(join(dir, "oauth.json")), { code: "ENOENT" });
    assert.equal((await status()).source, "environment");
  }));
