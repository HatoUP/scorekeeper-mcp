import assert from "node:assert/strict";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createProxyServer, type RemotePeer } from "../src/core.js";
import {
  LOGIN_HELP,
  REQUEST_TIMEOUT_MS,
  SCOREKEEPER_MCP_URL,
} from "../src/constants.js";
const tools: ListToolsResult = {
  tools: [
    {
      name: "get_service_info",
      description: "Current public service info",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "update_scoreboard",
      description: "Actual upstream score update",
      inputSchema: {
        type: "object",
        properties: { score: { type: "number" } },
        required: ["score"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { score: { type: "number" } },
        required: ["score"],
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: ["scoreboards:write"] }],
      },
    },
  ],
  nextCursor: "next-page",
  _meta: { catalogVersion: 12 },
};
async function fixture(remote: RemotePeer, authenticated = false) {
  const proxy = createProxyServer(remote, async () => authenticated);
  const client = new Client(
    { name: "bridge-test", version: "1" },
    { capabilities: {} },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([proxy.server.connect(a), client.connect(b)]);
  return {
    proxy,
    client,
    close: async () => {
      await client.close();
      await proxy.close();
    },
  };
}
function peer(overrides: Partial<RemotePeer> = {}): RemotePeer {
  return {
    listTools: async () => tools,
    callTool: async () => ({ content: [{ type: "text", text: "public" }] }),
    close: async () => {},
    ...overrides,
  };
}
test("fixed production endpoint has no environment URL override", () => {
  assert.equal(SCOREKEEPER_MCP_URL, "https://www.scorekeeper.co/api/mcp");
});
test("public initialize and dynamic paginated discovery preserve the upstream catalog", async () => {
  let cursor: unknown;
  const f = await fixture(
    peer({
      listTools: async (params, options) => {
        cursor = params?.cursor;
        assert.equal(options.timeout, REQUEST_TIMEOUT_MS);
        return tools;
      },
    }),
  );
  try {
    assert.equal(f.client.getServerVersion()?.name, "scorekeeper-stdio");
    assert.deepEqual(await f.client.listTools({ cursor: "page-2" }), tools);
    assert.equal(cursor, "page-2");
  } finally {
    await f.close();
  }
});
test("public service tool needs no credentials, protected calls never reach upstream without own credentials", async () => {
  const names: string[] = [];
  const f = await fixture(
    peer({
      callTool: async (params) => {
        names.push(params.name);
        return { content: [{ type: "text", text: "service-info" }] };
      },
    }),
  );
  try {
    assert.deepEqual(
      await f.client.callTool({ name: "get_service_info", arguments: {} }),
      { content: [{ type: "text", text: "service-info" }] },
    );
    const denied = await f.client.callTool({
      name: "update_scoreboard",
      arguments: { score: 2 },
    });
    assert.equal(denied.isError, true);
    assert.deepEqual(denied.content, [{ type: "text", text: LOGIN_HELP }]);
    assert.deepEqual(names, ["get_service_info"]);
  } finally {
    await f.close();
  }
});
test("authorized calls forward arguments/meta and return structured data/error flags unchanged", async () => {
  const result: CallToolResult = {
    isError: false,
    content: [{ type: "text", text: "updated" }],
    structuredContent: { score: 2 },
    _meta: { trace: "opaque" },
  };
  let received: unknown;
  const f = await fixture(
    peer({
      callTool: async (params, options) => {
        received = params;
        assert.equal(options.timeout, 60000);
        assert.equal(options.maxTotalTimeout, 60000);
        return result;
      },
    }),
    true,
  );
  try {
    const params = {
      name: "update_scoreboard",
      arguments: { score: 2 },
      _meta: { requestTag: "original" },
    };
    assert.deepEqual(await f.client.callTool(params), result);
    assert.deepEqual(received, params);
  } finally {
    await f.close();
  }
});
test("network/auth exceptions are sanitized and mutations are not retried", async () => {
  let calls = 0;
  const secret = "Bearer VERY_PRIVATE_TOKEN https://example.test/?code=private";
  const f = await fixture(
    peer({
      callTool: async () => {
        calls++;
        throw new Error(secret);
      },
    }),
    true,
  );
  try {
    await assert.rejects(
      f.client.callTool({ name: "update_scoreboard", arguments: { score: 2 } }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(secret));
        assert.match(error.message, /No operation was automatically retried/);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
  const g = await fixture(
    peer({
      callTool: async () => {
        throw Object.assign(new Error(secret), { code: 401 });
      },
    }),
    true,
  );
  try {
    await assert.rejects(
      g.client.callTool({ name: "update_scoreboard", arguments: {} }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /authorization.*expired/);
        assert.ok(!error.message.includes(secret));
        return true;
      },
    );
  } finally {
    await g.close();
  }
});
test("host cancellation propagates to the in-flight upstream request", async () => {
  let started!: () => void, cancelled!: () => void;
  const begun = new Promise<void>((r) => {
      started = r;
    }),
    stopped = new Promise<void>((r) => {
      cancelled = r;
    });
  const f = await fixture(
    peer({
      callTool: async (_params, options) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener(
            "abort",
            () => {
              cancelled();
              reject(new Error("cancelled"));
            },
            { once: true },
          );
          started();
        }),
    }),
    true,
  );
  try {
    const abort = new AbortController();
    const call = f.client.callTool(
      { name: "update_scoreboard", arguments: {} },
      undefined,
      { signal: abort.signal },
    );
    const rejected = assert.rejects(call);
    await begun;
    abort.abort();
    await rejected;
    await Promise.race([
      stopped,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("upstream cancellation missing")),
          1000,
        ),
      ),
    ]);
  } finally {
    await f.close();
  }
});
test("shutdown cancels requests and closes the upstream once", async () => {
  let closes = 0;
  const f = await fixture(
    peer({
      close: async () => {
        closes++;
      },
    }),
  );
  await f.proxy.close();
  await f.proxy.close();
  await f.client.close();
  assert.equal(closes, 1);
});

test("production SDK path is fixed, serializes requests and cancels queued mutations without sending them", async () => {
  const { createScorekeeperBridge } = await import("../src/core.js");
  const originalFetch = globalThis.fetch;
  let release!: () => void, started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const names: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), SCOREKEEPER_MCP_URL);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    const request = JSON.parse(String(init?.body)) as {
      id?: string | number;
      method: string;
      params?: { name: string };
    };
    if (!("id" in request)) return new Response(null, { status: 202 });
    let result: unknown;
    if (request.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "real-upstream-fixture", version: "1.2.0" },
      };
    else if (request.method === "tools/list") result = tools;
    else if (request.method === "tools/call") {
      names.push(request.params!.name);
      await new Promise<void>((resolve) => {
        release = resolve;
        started();
      });
      result = { content: [{ type: "text", text: "done" }] };
    } else throw new Error("Unexpected fixture method");
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  };
  const auth = {
    provider: {
      redirectUrl: undefined,
      clientMetadata: { redirect_uris: [] },
      clientInformation: () => undefined,
      tokens: () => undefined,
      saveTokens: () => {},
      redirectToAuthorization: () => {
        throw new Error("Interactive authorization forbidden");
      },
      saveCodeVerifier: () => {},
      codeVerifier: () => "unused",
    },
    hasCredentials: async () => true,
  };
  const bridge = createScorekeeperBridge(auth);
  const client = new Client(
    { name: "runtime-fixture", version: "1" },
    { capabilities: {} },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([bridge.server.connect(a), client.connect(b)]);
    await client.listTools();
    const first = client.callTool({ name: "first_mutation", arguments: {} });
    await began;
    const abort = new AbortController();
    const queued = client.callTool(
      { name: "never_sent_mutation", arguments: {} },
      undefined,
      { signal: abort.signal },
    );
    const rejected = assert.rejects(queued);
    abort.abort();
    await rejected;
    release();
    await first;
    await client.listTools(); // Drains the serialized queue after its aborted entry.
    assert.deepEqual(names, ["first_mutation"]);
  } finally {
    release?.();
    await client.close();
    await bridge.close();
    globalThis.fetch = originalFetch;
  }
});

test("real SDK unauthorized and revoked-refresh errors produce sanitized reconnect guidance", async () => {
  for (const error of [
    new UnauthorizedError("secret bearer"),
    new InvalidGrantError("secret refresh token"),
  ]) {
    const f = await fixture(
      peer({
        callTool: async () => {
          throw error;
        },
      }),
      true,
    );
    try {
      await assert.rejects(
        f.client.callTool({ name: "update_scoreboard", arguments: {} }),
        (e) => {
          assert.ok(e instanceof Error);
          assert.match(e.message, /authorization.*expired/);
          assert.ok(!e.message.includes("secret"));
          return true;
        },
      );
    } finally {
      await f.close();
    }
  }
});
