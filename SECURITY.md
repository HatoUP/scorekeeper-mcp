# Security

Report vulnerabilities privately to support@scorekeeper.co. Do not include access
tokens, OAuth codes, private scoreboard links, payment information or customer data
in public issues. Maintainer and publisher: Stormlight Ventures LLC.

This package is a single-user stdio bridge to the fixed Scorekeeper.co service.
It is not a shared HTTP gateway and cannot be pointed at another upstream server.
Use a separate process and credential directory for every user. Never bake tokens
into a container image, commit credentials, or share a user's credentials across
Glama deployments, workspaces or customers.

Only explicit login initiates browser authorization. Payment permissions are
optional. Protected calls require the current user's connection. No payment or
score mutation is automatically retried by the bridge after a transport failure;
inspect current status before an intentional retry. OAuth refresh is separate
from application mutation retries.

The public adapter's MIT license does not license Scorekeeper.co backend source,
customer data, trademarks or hosted-service access. Hosted services remain subject
to their own terms, limits, authorization and availability.
