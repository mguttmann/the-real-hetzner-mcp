# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you find a security issue in `@mguttmann/hetzner-cloud-mcp`, **do not open a public GitHub issue**. Instead, file a private security advisory:

[https://github.com/mguttmann/the-real-hetzner-mcp/security/advisories/new](https://github.com/mguttmann/the-real-hetzner-mcp/security/advisories/new)

Please include:

- The version (`npm view @mguttmann/hetzner-cloud-mcp version`)
- A minimal reproduction
- The impact you believe the issue has
- Optional: a proposed fix

You will receive an acknowledgement within 7 days and a fix or mitigation within 30 days for issues rated medium severity or higher.

## Scope

In scope: this npm package, its build pipeline, and the way it handles the user-supplied Hetzner API token. Out of scope: vulnerabilities in the Hetzner Cloud API itself (report those to Hetzner directly via [https://www.hetzner.com/legal/security/](https://www.hetzner.com/legal/security/)) and vulnerabilities in transitive dependencies that have public CVEs already (open a regular issue or PR instead).

## Threat model

This server holds a Hetzner Cloud API token (read-write) in memory while running. It exposes that token's authority to any MCP client connected over stdio. Treat the host machine and the MCP client as part of the trust boundary; do not run this server in untrusted environments.
