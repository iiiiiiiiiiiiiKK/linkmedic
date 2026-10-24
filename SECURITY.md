# Security policy

LinkMedic is a service that makes **outbound HTTP requests to URLs supplied by
strangers**. That is the classic shape of a Server-Side Request Forgery (SSRF)
vulnerability, so the guard rails are a first-class part of the design rather
than an afterthought.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

- Open a private GitHub security advisory:
  <https://github.com/iiiiiiiiiiiKK/linkmedic/security/advisories/new>
- Or contact the maintainer on X: [@0xkillcoin](https://x.com/0xkillcoin)

Include the URL that triggers the behaviour, the expected vs. actual result, and
any request/response evidence. We aim to acknowledge reports within 72 hours.

Out of scope: findings that require the reporter to control the DNS of the
target, or that only affect a self-hosted instance whose operator removed the
safety checks.

## What the SSRF guard actually does

Three independent gates run before a byte of the target is read.

### 1. Input normalisation (`shared/core/url.ts`)

| Rejected                                                        | Reason code                       |
| --------------------------------------------------------------- | --------------------------------- |
| Anything that is not `http:` / `https:`                         | `unsupported_scheme`              |
| `localhost`, `*.localhost`, `*.local`, `*.internal`, `metadata` | `blocked_target`                  |
| URLs with embedded `user:pass@` credentials                     | `credentials_not_allowed`         |
| Bare single-label hosts                                         | `invalid_host`                    |
| Any port other than 80 / 443                                    | `blocked_port`                    |
| Control characters, spaces, >2048 chars                         | `invalid_characters` / `too_long` |
| IP literals in a private range                                  | `blocked_target`                  |

### 2. Address classification (`shared/core/ip.ts`)

`classifyIp()` parses addresses itself instead of trusting a library, so
encoded forms cannot slip through. Blocked IPv4: `0.0.0.0/8`, `10/8`,
`100.64/10` (CGNAT), `127/8`, `169.254/16` (link-local + cloud metadata),
`172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`,
`198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4` (multicast), `240/4`.

Blocked IPv6: `::`, `::1`, `64:ff9b::/96` (NAT64), `100::/64`, `2001::/32`
(Teredo), `2001:db8::/32`, `2002::/16` (6to4), `fc00::/7` (unique-local),
`fe80::/10` (link-local), `ff00::/8` (multicast). **IPv4-mapped and
IPv4-compatible IPv6 addresses are unwrapped and judged by the IPv4 rules**, so
`::ffff:127.0.0.1` is refused exactly like `127.0.0.1`.

Leading-zero IPv4 octets (`010.0.0.1`) are rejected rather than guessed, because
some resolvers read them as octal.

### 3. DNS answer validation (`shared/core/dns.ts`)

Every hostname is resolved and **every** answer must be publicly routable. A
single private answer rejects the whole host — a mixed answer set is precisely
what a DNS-rebinding attempt looks like.

### 4. Per-hop re-validation

Redirects are never auto-followed. Each hop resolves the new URL, re-runs gates
1–3 and only then issues the request, with a hard limit of 5 hops and an explicit
loop detector. `http://169.254.169.254/` reached through a `Location:` header is
refused exactly like a direct request would be.

## Transport-level hardening

**Node transport (`shared/transport/nodetransport.ts`)** — connects to the IP it
already validated through a custom `lookup` callback, so the resolver is never
consulted a second time. DNS rebinding between check and connect is structurally
impossible, not merely unlikely.

**Edge transport (`shared/transport/edge.ts`)** — `fetch()` on Cloudflare Workers
cannot pin a socket, so the edge re-resolves DNS itself. That gap is closed by
the platform: the Workers runtime refuses to open connections to private,
loopback and link-local addresses (verified during development — `fetch` to
`127.0.0.1` returns error 1003, a hostname resolving to `127.0.0.1` returns
error 1016). The API reports `ipPinning: false` in `/api/health` and in every
report so the difference is visible instead of implied.

## Resource limits

| Limit               | Value                                          | Where                   |
| ------------------- | ---------------------------------------------- | ----------------------- |
| Page response body  | 512 KB read, then truncated                    | `diagnostics.ts`        |
| Link probe body     | 16 KB read                                     | `diagnostics.ts`        |
| Per-request timeout | 12 s page / 6 s link (edge), 15 s / 8 s (node) | transport options       |
| Redirect hops       | 5                                              | `followRedirects`       |
| Link probes         | 25 max, 4–5 concurrent                         | `MAX_LINK_CHECK_LIMIT`  |
| Whole-run budget    | 24 s edge / 30 s node                          | `budgetMs`              |
| Request body        | 8 KB                                           | `readJson`              |
| Rate limit          | 20 diagnoses / IP / minute (KV-backed)         | `functions/lib/http.ts` |

If the KV store is unavailable the limiter **fails open and says so**
(`rateLimitEnforced: false` in `/api/health`) rather than pretending to enforce a
limit.

## Credential and log hygiene

- No secrets exist in this project: there is no API key, no database credential
  and no third-party token. `.env.example` documents variables only.
- The server logs one line per unexpected failure: an error _name_, never a URL,
  a response body, a header or a stack trace.
- Every user-facing error is passed through `sanitizeMessage()`, which strips
  IPv4 addresses and caps the length.
- Reports are built in memory and returned; nothing is persisted server-side.
  History lives in the visitor's `localStorage`.
- Exported CSV neutralises spreadsheet formula injection (`=`, `+`, `-`, `@`)
  by prefixing a single quote.

## Response headers on LinkMedic itself

`Content-Security-Policy` (`default-src 'self'`, no inline script,
`frame-ancestors 'none'`, `object-src 'none'`), `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy`,
`Permissions-Policy`, `Strict-Transport-Security`,
`Cross-Origin-Opener-Policy`.

## Accepted limitations

- **Certificate details on the edge.** Cloudflare Workers cannot read the leaf
  certificate's subject/issuer/expiry, so the edge build reports a _verdict_
  (valid / rejected via HTTP 526) and `certificateDetails: false`. It never
  fabricates a subject or an expiry date. Deploy the Node server for full
  details.
- **HEAD-then-GET probing.** Link checks send `HEAD` first and fall back to `GET`
  when a server rejects `HEAD`, which some WAFs see as two requests.
- **Rate limiting is fixed-window over KV.** KV is eventually consistent, so the
  limiter is an abuse brake, not a hard quota.
- **The checker is not a browser.** It does not execute JavaScript, so
  client-rendered SPAs may look thinner than they are. This is stated in the UI.
