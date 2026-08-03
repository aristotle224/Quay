# Security Policy

Stellar Checkout handles payment flows, so we take security reports seriously.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Instead, report privately using one of:

- GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  (the **Security** tab → **Report a vulnerability**), or
- email the maintainer at **adenijiayomideay@gmail.com**.

Please include:

- a description of the vulnerability and its impact,
- steps to reproduce (proof-of-concept if possible),
- affected component(s) and version/commit,
- any suggested remediation.

## What to expect

- We aim to acknowledge a report within **5 business days**.
- We will keep you updated on progress and let you know when a fix is released.
- We ask that you give us a reasonable window to remediate before any public
  disclosure.

## Scope notes

This project is currently **pre-production**. Several things are intentionally not
production-ready and are documented as such in the [README](./README.md):

- **No authentication** — a single hard-coded demo seller, no API keys or login.
- **The off-ramp is a mock** — `MockAnchorOffRamp` moves no money.
- **USDC issuers in `.env.example` are placeholders** that must be verified per network.

Reports about these *known, documented* limitations are appreciated but may be
closed as "by design (pre-production)". Reports about unexpected behaviour — for
example a way to bypass the payment-matching or idempotency guards, forge a webhook
signature, or cause incorrect money math — are exactly what we want to hear about.

## Dependency and secret scanning (issue 8.5)

- **`pnpm audit --audit-level=high`** runs in CI on every push/PR, checked
  against an explicit allowlist (`.github/audit-allowlist.txt`) - only
  advisories listed there (each with a reasoning comment) are permitted to
  pass; anything else fails the build.
- **Dependabot** (`.github/dependabot.yml`) watches both the npm workspace
  and GitHub Actions, grouped into one weekly PR per ecosystem.
- **gitleaks** runs in CI (`.gitleaks.toml`, extending gitleaks' default
  rule set with a rule specifically matching a Stellar secret seed -
  `S` followed by 55 base32 characters) and is available as a local
  pre-commit hook: `git config core.hooksPath .githooks` (requires
  [gitleaks](https://github.com/gitleaks/gitleaks#installing) installed
  locally; the hook skips itself with a warning if it isn't, so it never
  silently blocks a commit for missing tooling - CI still catches a leaked
  secret on push either way).
- **GitHub's built-in secret scanning and push protection** should be
  enabled on this repository - these are repository **Settings** toggles
  (Settings → Code security and analysis), not something a pull request can
  turn on. Maintainers: enable both "Secret scanning" and "Push protection"
  there if not already on.

### Secret rotation

| Secret | Where it's set | Rotation procedure |
|---|---|---|
| `DEFAULT_SELLER_SECRET` | Render env var (or local `.env`) | This is the seller wallet's Stellar secret key, used to sign SEP-10 auth challenges when `OFFRAMP=testanchor`. Generate a new Stellar keypair, update `DEFAULT_SELLER_WALLET`/`DEFAULT_SELLER_SECRET` together, redeploy. In-flight payment links pointed at the *old* wallet address remain valid payment destinations (Stellar payments don't depend on which key signs SEP-10 auth) but new SEP-10 challenges will be signed by the new key - coordinate with whichever anchor is configured, since it will have seen the old public key during its own auth/KYC flow. |
| `DATABASE_AUTH_TOKEN` | Render env var | Turso auth token. Create a new one (`turso db tokens create <db>` or the Turso dashboard), update the Render env var, redeploy, confirm the new deploy is healthy, then revoke the old token. |
| `JWT_SECRET` | Render env var (or local `.env`) | Signs the session JWTs minted after a SEP-10 wallet login (`POST /auth`). Rotating it invalidates every outstanding session immediately, forcing all sellers to log in again; there is no mixed-validity window today, so rotate during a quiet period or accept the forced re-authentication. Revoked-token rows keyed by `jti` become inert on rotation and are swept on their own expiry. Required explicitly on `public`; auto-generates an ephemeral secret on testnet, which means a restart silently rotates it. |

Rotating any of the above requires updating the value in Render's dashboard
(or wherever it's actually deployed) and redeploying - none of these are
read from a file this repo ships, so there's nothing to "rotate" inside the
repo itself beyond this table staying accurate.
