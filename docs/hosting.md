# Hosting Scorekeeper MCP

## Remote connector

Use `https://www.scorekeeper.co/api/mcp` with Streamable HTTP. The endpoint supports
public initialization, tool listing and `get_service_info`. Protected tools use
OAuth authorization code with PKCE S256 and dynamic public-client registration.
Declare OAuth authentication in directories even though discovery is public.

Resource metadata:
`https://www.scorekeeper.co/.well-known/oauth-protected-resource/api/mcp`

Authorization server metadata:
`https://www.scorekeeper.co/.well-known/oauth-authorization-server`

Default scopes are `scoreboards:read scoreboards:write`. Optional billing scopes
are `billing:read billing:checkout`; request them through explicit user consent.
Connect every user separately. A publisher's own access token must never serve
all users of a public connector.

## Stdio container

The public image is `ghcr.io/hatoup/scorekeeper-mcp:v1.0.0`. It can be pulled
without a GitHub account. The release build passed MCP initialization and ping
with networking disabled in GitHub CI. Versioned image reference:

```sh
docker run --rm -i ghcr.io/hatoup/scorekeeper-mcp:v1.0.0
```

Build the root Dockerfile and run its default command. The image uses Node.js 22,
installs locked dependencies, runs as `node`, writes MCP messages to stdout, and
uses stderr for fixed diagnostics. No port or HTTP health URL is exposed.

| Setting | Value |
| --- | --- |
| Build context | Repository root |
| Dockerfile | `Dockerfile` |
| Entrypoint | `node dist/src/cli.js` |
| Arguments | `serve` |
| Protocol | MCP over stdio |
| Startup secrets | None |
| Network for real tool calls | HTTPS to `www.scorekeeper.co` |
| Persistent credentials | A private per-user directory |

The default process can initialize and respond to ping with networking disabled.
Tool listing and service information require the live upstream. Missing
credentials produce connection guidance for protected tool calls.

### Per-user credentials

`SCOREKEEPER_CONFIG_DIR` optionally selects the private credential directory.
Otherwise it is `~/.config/scorekeeper-mcp`. The directory must be owned by the
process user with mode `0700`; its `oauth.json` must have mode `0600`. Do not commit,
log, upload, or bake this directory into an image. Keep a separate directory and
process for every user. POSIX file permissions are required by this release.

For a local Docker client, complete login on the host first, then mount that one
user's credential directory into the container at
`/home/node/.config/scorekeeper-mcp`, ensuring that container UID 1000 can own/read
it privately. File ownership differs across host operating systems; do not make
credentials world-readable to solve a mount problem. Prefer the native remote
OAuth connection when a platform cannot provide private per-user storage.

`SCOREKEEPER_ACCESS_TOKEN` can supply the current user's existing short-lived
Scorekeeper OAuth access token through a host's secret store. It is optional,
secret, and has no default. It overrides the local OAuth connection and cannot
refresh itself. Expiry requires replacement through the user's authorized login
flow. A guest REST token does not authorize protected MCP tools. Never publish a
real or shared token as a build placeholder.

The upstream URL cannot be overridden. The process is deliberately not a shared
HTTP proxy. There are no Firebase, Stripe, bank or website administrator secrets
in this package.

## Glama

Submit the public GitHub URL, product name and short description through Glama's
MCP server directory. Its indexing checks include license, security and health.
The root Dockerfile supplies a runnable stdio build; no credential is required to
start or health-check it.

For a hosted release, a verified maintainer must open the listing's Dockerfile
admin page, configure the build and environment schema, run the build test, then
publish a **Glama release**. A GitHub release alone does not complete this step.
Set `SCOREKEEPER_ACCESS_TOKEN` as an optional secret only if the deployment is
isolated to that token's owner; otherwise use the remote OAuth connector.

The current `glama.json` schema defines `maintainers` as GitHub **usernames**.
An organization slug is not a substitute for a maintainer account. Ownership
configuration must use a verified company-controlled account. Build commands and
environment schemas belong in the host's documented admin configuration; do not
invent additional `glama.json` keys.

Remote connector ownership can instead be verified through the `scorekeeper.co`
domain using the exact DNS or HTTP claim supplied by Glama. The connector should
declare OAuth, with dynamic registration rather than a shared test token.

Platform approval and hosting availability depend on the platform's checks and
release process. This repository does not claim approval merely because its
Dockerfile exists.

Sources checked October 29, 2026:
[Glama FAQ](https://glama.ai/mcp/faq),
[metadata schema](https://glama.ai/mcp/schemas/server.json), and
[release process](https://glama.ai/blog/2026-03-15-how-to-make-a-release).

## Official MCP Registry

The remote server is published under `co.scorekeeper/scorekeeper`; the root
`server.json` identifies the endpoint and public source repository. The hosted
server and stdio adapter have separate release versions. Only add an npm or OCI
package entry after that exact package is publicly available and verified.

[Official remote-server publishing documentation](https://modelcontextprotocol.io/registry/remote-servers).
