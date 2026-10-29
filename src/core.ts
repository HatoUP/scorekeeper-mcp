import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ToolListChangedNotificationSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsRequest,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { createAuthContext } from "./auth.js";
import {
  LOGIN_HELP,
  REQUEST_TIMEOUT_MS,
  SCOREKEEPER_MCP_URL,
  VERSION,
} from "./constants.js";

type AuthContext = Awaited<ReturnType<typeof createAuthContext>>;
export interface RemotePeer {
  listTools(
    params: ListToolsRequest["params"],
    options: RequestOptions,
  ): Promise<ListToolsResult>;
  callTool(
    params: CallToolRequest["params"],
    options: RequestOptions,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}
function authFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    code?: unknown;
    name?: unknown;
    error?: unknown;
    errorCode?: unknown;
  };
  return (
    error instanceof UnauthorizedError ||
    e.code === 401 ||
    e.name === "UnauthorizedError" ||
    e.error === "invalid_grant" ||
    e.errorCode === "invalid_grant" ||
    e.errorCode === "invalid_client" ||
    e.errorCode === "invalid_token"
  );
}
/** Do not interpolate remote errors: they can include headers, request bodies or secrets. */
function safeFailure(error: unknown): McpError {
  if (authFailure(error))
    return new McpError(
      ErrorCode.InvalidRequest,
      `Scorekeeper authorization is unavailable or expired. ${LOGIN_HELP}`,
    );
  if (
    (error instanceof McpError && error.code === ErrorCode.RequestTimeout) ||
    (error instanceof Error && error.name === "TimeoutError")
  )
    return new McpError(
      ErrorCode.RequestTimeout,
      "Scorekeeper request timed out. No operation was automatically retried; check its current status before retrying.",
    );
  return new McpError(
    ErrorCode.InternalError,
    "Scorekeeper request failed. No operation was automatically retried; check its current status before retrying. Run scorekeeper-mcp login if your connection needs authorization.",
  );
}

/** A testable protocol adapter. Production connects only through createScorekeeperBridge. */
export function createProxyServer(
  remote: RemotePeer,
  hasCredentials: () => Promise<boolean>,
) {
  const shutdown = new AbortController();
  const server = new Server(
    { name: "scorekeeper-stdio", title: "Scorekeeper.co", version: VERSION },
    {
      capabilities: { tools: { listChanged: true } },
      instructions:
        "Use get_service_info for current Scorekeeper setup and capabilities. Tool definitions come directly from Scorekeeper.co. This stdio process belongs to one user; protected calls use that user's explicit connection. Preserve requestId on intentional retries and verify current status before retrying an interrupted mutation.",
    },
  );
  function options(signal: AbortSignal): RequestOptions {
    return {
      signal: AbortSignal.any([signal, shutdown.signal]),
      timeout: REQUEST_TIMEOUT_MS,
      maxTotalTimeout: REQUEST_TIMEOUT_MS,
    };
  }
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    try {
      return await remote.listTools(request.params, options(extra.signal));
    } catch (error) {
      throw safeFailure(error);
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (
        request.params.name !== "get_service_info" &&
        !(await hasCredentials())
      )
        return { isError: true, content: [{ type: "text", text: LOGIN_HELP }] };
      return await remote.callTool(request.params, options(extra.signal));
    } catch (error) {
      throw safeFailure(error);
    }
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    shutdown.abort();
    await Promise.allSettled([server.close(), remote.close()]);
  };
  server.onclose = () => {
    void close();
  };
  // The caller may log a fixed diagnostic, never an exception object.
  server.onerror = () => {};
  return { server, close };
}

export function createScorekeeperBridge(auth: AuthContext) {
  const client = new Client(
    { name: "scorekeeper-stdio", version: VERSION },
    { capabilities: {} },
  );
  const lifetime = new AbortController();
  let activeSignal: AbortSignal | undefined;
  let connecting: Promise<void> | undefined;
  let closed = false;
  const connect = async (signal: AbortSignal) => {
    if (closed) throw new Error("Bridge closed");
    if (!connecting) {
      connecting = client
        .connect(
          new StreamableHTTPClientTransport(new URL(SCOREKEEPER_MCP_URL), {
            authProvider: auth.provider,
            // SDK protocol deadlines alone do not abort the HTTP fetch. Bind
            // every transport/auth fetch to the current serialized operation.
            fetch: (input, init) => {
              const url = typeof input === "string" ? input : input.href;
              if (
                ![
                  SCOREKEEPER_MCP_URL,
                  "https://www.scorekeeper.co/api/agents/oauth/token",
                ].includes(url)
              )
                return Promise.reject(
                  new Error("Unexpected upstream endpoint"),
                );
              return fetch(input, {
                ...init,
                redirect: "error",
                signal: AbortSignal.any([
                  lifetime.signal,
                  ...(activeSignal ? [activeSignal] : []),
                  ...(init?.signal ? [init.signal] : []),
                  AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                ]),
              });
            },
            requestInit: { redirect: "error" },
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
          }),
          {
            signal: AbortSignal.any([lifetime.signal, signal]),
            timeout: REQUEST_TIMEOUT_MS,
            maxTotalTimeout: REQUEST_TIMEOUT_MS,
          },
        )
        .catch((error) => {
          connecting = undefined;
          throw error;
        });
    }
    await connecting;
    if (closed) {
      await client.close();
      throw new Error("Bridge closed");
    }
  };
  // A refresh token rotates once: serialize complete SDK operations, not just
  // token storage. Queueing never replays an application mutation.
  let queue: Promise<unknown> = Promise.resolve();
  const run = <T>(
    operation: (options: RequestOptions) => Promise<T>,
    options: RequestOptions,
  ) => {
    const end = Date.now() + REQUEST_TIMEOUT_MS;
    const signal = AbortSignal.any([
      options.signal ?? lifetime.signal,
      lifetime.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]);
    const result = queue.then(async () => {
      signal.throwIfAborted();
      activeSignal = signal;
      try {
        await connect(signal);
        signal.throwIfAborted();
        const remaining = Math.max(1, end - Date.now());
        return await operation({
          ...options,
          signal,
          timeout: remaining,
          maxTotalTimeout: remaining,
        });
      } finally {
        activeSignal = undefined;
      }
    });
    queue = result.catch(() => undefined);
    return result;
  };
  const proxy = createProxyServer(
    {
      listTools: async (params, options) =>
        run((opts) => client.listTools(params, opts), options),
      callTool: async (params, options) =>
        run(
          async (opts) =>
            CallToolResultSchema.parse(
              await client.callTool(params, CallToolResultSchema, opts),
            ),
          options,
        ),
      close: async () => {
        closed = true;
        lifetime.abort();
        await client.close();
      },
    },
    () => auth.hasCredentials(),
  );
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    await proxy.server
      .notification({ method: "notifications/tools/list_changed" })
      .catch(() => undefined);
  });
  client.onerror = () => {};
  return proxy;
}
