# Working on Scorekeeper MCP

Publisher, author and copyright holder: **Stormlight Ventures LLC**. Organization:
**HatoUP**. Never publish an individual identity or real credentials in source,
fixtures, commits, examples or metadata.

This repository contains the single-user stdio adapter. Its fixed upstream is
`https://www.scorekeeper.co/api/mcp`. Preserve per-user OAuth isolation, explicit
billing consent, loopback PKCE, private credential permissions, sanitized errors
and the absence of automatic mutation retries. Do not add a generic upstream URL
override or turn it into a shared authenticated gateway.

Use `npm run hooks:install` inside this standalone repository. Commit hooks check
the isolated staged tree; push hooks check outgoing commits. Run fresh checks,
fix failures, and never bypass hooks. Tests must use mock/local services and
temporary `SCOREKEEPER_CONFIG_DIR` directories, never customer accounts. Do not
override `HOME` or `CODEX_HOME`. Keep fixtures free of real tokens and private URLs.

The hosted tool catalog is authoritative. Preserve schemas, annotations,
structured content and error results. Do not duplicate prices or imply that a
payment method is enabled merely because its tool is discoverable.

Before a release, verify the package contents, company metadata, Docker startup
and public artifact availability. A directory listing is not proof of approval
or hostability. Never publish a maintainer username that has not been authorized.
