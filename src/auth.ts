import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const ORIGIN = "https://www.scorekeeper.co";
const RESOURCE = `${ORIGIN}/api/mcp`;
const BASE_SCOPES = ["scoreboards:read", "scoreboards:write"];
const ALL_SCOPES = [...BASE_SCOPES, "billing:read", "billing:checkout"];
type State = {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens & { issuer?: string };
  redirect?: string;
  scopes?: string[];
  expiresAt?: number;
};
export type AuthStatus = {
  authenticated: boolean;
  source: "environment" | "local" | "none";
  scopes: string[];
  expiresAt: number | null;
};
export type LoginOptions = {
  billing?: boolean;
  openBrowser?: boolean;
  timeoutMs?: number;
};
const fail = () =>
  new Error(
    "Authentication unavailable. Run scorekeeper login again; check private local credential permissions.",
  );
const configDir = () =>
  resolve(
    process.env.SCOREKEEPER_CONFIG_DIR ||
      join(homedir(), ".config", "scorekeeper-mcp"),
  );
const stateFile = () => join(configDir(), "oauth.json");
function safeScopes(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((s) => typeof s !== "string" || !ALL_SCOPES.includes(s))
  )
    throw fail();
  return [...new Set(value as string[])];
}
async function checkDirectory(create = false): Promise<boolean> {
  const dir = configDir();
  try {
    const stat = await fs.lstat(dir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw fail();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fail();
    if (!create) return false;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return checkDirectory();
  }
}
function validateState(value: unknown): State {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const s = value as State;
  if (s.scopes) safeScopes(s.scopes);
  if (s.redirect) {
    const u = new URL(s.redirect);
    if (
      u.protocol !== "http:" ||
      u.hostname !== "127.0.0.1" ||
      u.pathname !== "/callback" ||
      !u.port ||
      u.search ||
      u.hash ||
      u.username ||
      u.password
    )
      throw fail();
  }
  if (
    s.client &&
    (typeof s.client.client_id !== "string" ||
      s.client.client_secret ||
      (s.client.issuer && s.client.issuer !== ORIGIN))
  )
    throw fail();
  if (
    s.tokens &&
    (typeof s.tokens.access_token !== "string" ||
      !s.tokens.access_token ||
      typeof s.tokens.token_type !== "string" ||
      s.tokens.token_type.toLowerCase() !== "bearer" ||
      (s.tokens.refresh_token !== undefined &&
        (typeof s.tokens.refresh_token !== "string" ||
          !s.tokens.refresh_token)) ||
      (s.tokens.expires_in !== undefined &&
        (!Number.isSafeInteger(s.tokens.expires_in) ||
          s.tokens.expires_in < 0)) ||
      (s.tokens.scope !== undefined && typeof s.tokens.scope !== "string") ||
      (s.tokens.issuer && s.tokens.issuer !== ORIGIN))
  )
    throw fail();
  if (
    s.expiresAt !== undefined &&
    (!Number.isSafeInteger(s.expiresAt) || s.expiresAt < 0)
  )
    throw fail();
  return s;
}
async function readState(): Promise<State> {
  if (!(await checkDirectory())) return {};
  let file;
  try {
    file = await fs.open(
      stateFile(),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 32768 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw fail();
    return validateState(JSON.parse(await file.readFile("utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw fail();
  } finally {
    await file?.close();
  }
}
let writeQueue = Promise.resolve();
function writeState(state: State): Promise<void> {
  const task = writeQueue.then(async () => {
    await checkDirectory(true);
    await readState(); // Reject unsafe existing files instead of replacing them.
    const temporary = join(
      configDir(),
      `.oauth-${randomBytes(12).toString("hex")}.tmp`,
    );
    try {
      const file = await fs.open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(JSON.stringify(validateState(state)));
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temporary, stateFile());
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  });
  writeQueue = task.catch(() => undefined);
  return task;
}
function environmentToken(): string | undefined {
  const token = process.env.SCOREKEEPER_ACCESS_TOKEN;
  if (token !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(token)) throw fail();
  return token;
}
function discovery(scopes: string[]) {
  return {
    authorizationServerUrl: ORIGIN,
    resourceMetadataUrl: `${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`,
    resourceMetadata: {
      resource: RESOURCE,
      authorization_servers: [ORIGIN],
      scopes_supported: scopes,
    },
    authorizationServerMetadata: {
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/agents/connect`,
      token_endpoint: `${ORIGIN}/api/agents/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/agents/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
    },
  };
}
function makeProvider(
  initial: State,
  interactive?: {
    redirect: string;
    scopes: string[];
    state: string;
    authorize: (url: URL) => Promise<void>;
  },
): OAuthClientProvider {
  let current = initial,
    verifier: string | undefined;
  const scopes = interactive?.scopes ?? current.scopes ?? BASE_SCOPES;
  return {
    get redirectUrl() {
      return interactive?.redirect ?? current.redirect;
    },
    get clientMetadata() {
      return {
        client_name: "Scorekeeper — Stormlight Ventures LLC",
        redirect_uris: [
          interactive?.redirect ??
            current.redirect ??
            "http://127.0.0.1:1/callback",
        ],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: scopes.join(" "),
      };
    },
    state: () => interactive?.state ?? "",
    clientInformation: () => {
      if (!interactive && (environmentToken() || !current.client)) throw fail();
      return current.client;
    },
    saveClientInformation: async (client) => {
      if (!interactive) {
        if (!current.client || client.client_id !== current.client.client_id)
          throw fail();
      }
      current = validateState({ ...current, client });
      if (!interactive) await writeState(current);
    },
    tokens: () => {
      const token = !interactive && environmentToken();
      return token
        ? { access_token: token, token_type: "Bearer" }
        : current.tokens;
    },
    saveTokens: async (tokens) => {
      if (!interactive && environmentToken()) throw fail();
      current = validateState({
        ...current,
        tokens,
        redirect: interactive?.redirect ?? current.redirect,
        scopes: safeScopes(
          (tokens.scope ?? scopes.join(" ")).split(" ").filter(Boolean),
        ),
        expiresAt:
          tokens.expires_in === undefined
            ? undefined
            : Date.now() + tokens.expires_in * 1000,
      });
      await writeState(current);
    },
    redirectToAuthorization: async (url) => {
      if (!interactive) throw fail();
      await interactive.authorize(url);
    },
    saveCodeVerifier: (value) => {
      if (!interactive || !/^[A-Za-z0-9._~-]{43,128}$/.test(value))
        throw fail();
      verifier = value;
    },
    codeVerifier: () => {
      if (!verifier) throw fail();
      return verifier;
    },
    validateResourceURL: async (server, resource) => {
      if (String(server) !== RESOURCE || (resource && resource !== RESOURCE))
        throw fail();
      return new URL(RESOURCE);
    },
    discoveryState: () => discovery(scopes),
    invalidateCredentials: async (scope) => {
      if (interactive) {
        current = {};
        verifier = undefined;
        return;
      }
      if (environmentToken()) return;
      if (scope === "tokens" || scope === "all") delete current.tokens;
      if (scope === "client" || scope === "all") delete current.client;
      if (scope === "verifier" || scope === "all") verifier = undefined;
      if (scope !== "discovery") await writeState(current);
    },
  };
}
export async function createAuthContext(): Promise<{
  provider: OAuthClientProvider;
  hasCredentials(): Promise<boolean>;
}> {
  const state = await readState();
  environmentToken();
  return {
    provider: makeProvider(state),
    hasCredentials: async () => {
      const stored = await readState();
      return (
        !!environmentToken() ||
        !!(
          stored.tokens &&
          (stored.tokens.refresh_token ||
            stored.expiresAt === undefined ||
            stored.expiresAt > Date.now())
        )
      );
    },
  };
}
export async function status(): Promise<AuthStatus> {
  const token = environmentToken(),
    state = await readState();
  return {
    authenticated:
      !!token ||
      !!(
        state.tokens &&
        (state.tokens.refresh_token ||
          state.expiresAt === undefined ||
          state.expiresAt > Date.now())
      ),
    source: token ? "environment" : state.tokens ? "local" : "none",
    scopes: token ? [] : (state.scopes ?? []),
    expiresAt: token ? null : (state.expiresAt ?? null),
  };
}
function approvedAuthorization(
  url: URL,
  redirect: string,
  state: string,
  scopes: string[],
) {
  if (
    url.origin !== ORIGIN ||
    url.pathname !== "/agents/connect" ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.get("redirect_uri") !== redirect ||
    url.searchParams.get("state") !== state ||
    url.searchParams.get("resource") !== RESOURCE ||
    url.searchParams.get("scope") !== scopes.join(" ") ||
    url.searchParams.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge") ?? "")
  )
    throw fail();
}
async function showAuthorization(url: URL, openBrowser: boolean) {
  process.stderr.write(`Authorize Scorekeeper in your browser:\n${url.href}\n`);
  if (!openBrowser) return;
  const command =
    process.platform === "darwin"
      ? "/usr/bin/open"
      : process.platform === "linux"
        ? "xdg-open"
        : undefined;
  if (!command) return;
  await new Promise<void>((resolve) => {
    const child = spawn(command, [url.href], { shell: false, stdio: "ignore" });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}
export async function login(options: LoginOptions = {}): Promise<AuthStatus> {
  if (environmentToken())
    throw new Error("Unset SCOREKEEPER_ACCESS_TOKEN before using local login.");
  await readState();
  const timeout = options.timeoutMs ?? 180000;
  if (!Number.isSafeInteger(timeout) || timeout < 50 || timeout > 300000)
    throw fail();
  const scopes = options.billing ? ALL_SCOPES : BASE_SCOPES;
  const nonce = randomBytes(32).toString("base64url");
  let finish!: (code: string) => void, rejectCallback!: (reason: Error) => void;
  const callback = new Promise<string>((resolve, reject) => {
    finish = resolve;
    rejectCallback = reject;
  });
  let redirect = "",
    consumed = false;
  const server = createServer((request, response) => {
    const headers = {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    let url: URL;
    try {
      url = new URL(request.url ?? "", redirect);
    } catch {
      response.writeHead(400, headers).end("Invalid callback.");
      return;
    }
    if (
      request.method !== "GET" ||
      request.headers.host !== new URL(redirect).host ||
      url.pathname !== "/callback" ||
      url.origin !== new URL(redirect).origin ||
      consumed ||
      (request.url?.length ?? 0) > 8192
    ) {
      response.writeHead(400, headers).end("Invalid callback.");
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    if (
      url.searchParams.getAll("state").length !== 1 ||
      Buffer.byteLength(state) !== Buffer.byteLength(nonce) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(nonce))
    ) {
      response.writeHead(400, headers).end("Invalid callback.");
      return;
    }
    const code = url.searchParams.get("code");
    if (
      url.searchParams.has("error") ||
      !code ||
      code.length > 2048 ||
      url.searchParams.getAll("code").length !== 1
    ) {
      consumed = true;
      response.writeHead(400, headers).end("Authorization was not completed.");
      rejectCallback(fail());
      return;
    }
    consumed = true;
    response
      .writeHead(200, headers)
      .end("Authorization received. You may close this window.");
    finish(code);
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.maxConnections = 8;
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(fail());
    }, timeout);
  });
  // A rejected callback can arrive while the initial authorization request finishes.
  void callback.catch(() => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw fail();
    redirect = `http://127.0.0.1:${address.port}/callback`;
    const provider = makeProvider(
      {},
      {
        redirect,
        scopes,
        state: nonce,
        authorize: async (url) => {
          approvedAuthorization(url, redirect, nonce, scopes);
          await showAuthorization(url, options.openBrowser !== false);
        },
      },
    );
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (
        url.origin !== ORIGIN ||
        !["/api/agents/oauth/register", "/api/agents/oauth/token"].includes(
          url.pathname,
        ) ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        throw fail();
      return fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
      });
    };
    await Promise.race([
      (async () => {
        const started = await auth(provider, {
          serverUrl: RESOURCE,
          scope: scopes.join(" "),
          fetchFn,
        });
        if (started !== "REDIRECT") throw fail();
        const code = await callback;
        const result = await auth(provider, {
          serverUrl: RESOURCE,
          authorizationCode: code,
          scope: scopes.join(" "),
          fetchFn,
        });
        if (result !== "AUTHORIZED") throw fail();
      })(),
      deadline,
    ]);
    return status();
  } catch {
    throw fail();
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
export async function logout(): Promise<{
  loggedOut: true;
  remoteRevoked: boolean;
  environmentTokenStillSet: boolean;
}> {
  const state = await readState();
  let remoteRevoked = false;
  if (state.tokens?.refresh_token) {
    try {
      const result = await fetch(`${ORIGIN}/api/agents/oauth/revoke`, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: state.tokens.refresh_token,
          token_type_hint: "refresh_token",
          ...(state.client ? { client_id: state.client.client_id } : {}),
        }),
        signal: AbortSignal.timeout(5000),
      });
      remoteRevoked = result.ok;
    } catch {
      /* Local logout still succeeds when offline. */
    }
  }
  if (await checkDirectory())
    await fs.unlink(stateFile()).catch((error) => {
      if (error.code !== "ENOENT") throw fail();
    });
  return {
    loggedOut: true,
    remoteRevoked,
    environmentTokenStillSet: !!environmentToken(),
  };
}
