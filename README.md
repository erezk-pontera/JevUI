# JevUI

A browser tester for [TypeSafe Jev](https://docs.typesafe.ai), served through a Cloudflare Worker that
holds your credentials so the page never has to.

Jev answers structured questions about a piece of content. You send a `state` (the thing to judge) and a
map of `questions`, and you get one typed answer per question: a probability for yes/no, a chosen option,
or a position on a scale. This repo gives you somewhere to write those requests by hand, run them, and
read the answers without wiring anything up first.

```
worker.js     Cloudflare Worker: auth, the HTTP endpoint, and an MCP server
index.html    the tester UI, one self-contained file, no build step
```

---

## worker.js

A Workers AI proxy in front of `typesafe/jev`, with two routes behind one gate. It exists so the
model binding and the shared secret stay server-side, so a static page can call it from anywhere, and
so MCP clients can use Jev as a tool.

| Route | What it is |
|---|---|
| `POST /` | The original endpoint. The JSON body goes to the model untouched. Any path other than `/mcp` still lands here, so existing callers keep working. |
| `POST /mcp` | A Model Context Protocol server over Streamable HTTP, exposing one tool, `jev_evaluate`. |
| `OPTIONS *` | CORS preflight. Needs no token, since browsers never send one on a preflight. |

**The gate.** Both routes read `Authorization: Bearer <token>` and compare it to the `AUTHN` secret.
Both sides are hashed with SHA-256 first and the digests compared with `crypto.subtle.timingSafeEqual`,
so the time the check takes does not depend on how much of a guess matched or on the secret's length.
(Hashing a longer *guess* takes longer, but that reveals nothing about the secret.) The scheme name is
matched case-insensitively, as RFC 7235 requires; the token is not. A missing header, a missing secret,
a wrong token, or a refused origin all return an empty **404** — deliberately the same answer as an
unknown path, so probing tells you nothing about which routes exist, which protocols are served, or
whether a token was close. A CORS preflight (`OPTIONS`) gets a generic answer, as browsers require; it
echoes back only the headers the browser asked about, so it does not advertise the MCP headers either.

**`POST /`**, once past the gate: the body must parse as a JSON object (**400** otherwise, with
`{ error, details }`), is capped at 1 MiB (**413**), and goes to `env.AI.run('typesafe/jev', payload)`.
Model failures return **500** with a generic message and a `requestId` — Cloudflare's ray ID where there is
one, so it matches the edge logs. The underlying error is logged under that ID and never returned, since it
can name internal hosts or configuration; the payload is never logged at all, since it may carry customer
data. The body is passed through untouched, so the worker does not change when the request schema gains
a field.

### MCP

`POST /mcp` speaks Streamable HTTP with plain JSON responses. It is stateless: no sessions, no
server-initiated stream, nothing kept between calls, so it scales like any other worker route.

**One tool, `jev_evaluate`**, taking `state` (text, or a JSON object or array) and `questions` (a map
keyed by question id, each with a `type` of `noul`, `choice` or `score` and `instructions`). It returns
the model's answer twice: as text, and as `structuredContent` for clients that read structured results.
It is annotated read-only, non-destructive and non-idempotent, since model output can vary between
identical calls.

Bad arguments come back as a tool result with `isError: true` and a message saying what to fix, rather
than as a protocol error, so the calling model can correct itself. A failure inside the model is different:
the caller gets a generic `isError` result with a request ID, and the detail goes only to the log, under the
same rule as `POST /`. Only `state` and `questions` are
forwarded to the model.

**Both protocol eras are served**, chosen per request by the shape of the request:

| Revision | How a client uses it | What the worker does |
|---|---|---|
| `2026-07-28` (current) | No handshake. Every request names its version in `params._meta` | Validates the version and `clientCapabilities`, checks that the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers agree with the body, and returns `resultType`, cache hints on `tools/list`, and server identity in `_meta` |
| `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` | `initialize`, then requests | Negotiates the version the client asked for, or the newest of these if it asked for one it does not know |

`server/discover` answers with or without `_meta`, which is how a client that does not yet know the
server works out which revision to speak. Methods the current revision removed (`initialize`, `ping`)
return method-not-found when called the modern way. `GET` and `DELETE` on `/mcp` return **405**, since
there is no stream or session to serve.

JSON-RPC batches are accepted, because `2025-03-26` requires servers to take them, and answered with an
array of responses. They are capped at 16 messages and run one at a time, since a batch is one HTTP
request that can ask for many model calls.

**Compatibility, as tested** with the official TypeScript SDK client, each connecting, listing and
calling the tool:

| Client | Opens with | Result |
|---|---|---|
| SDK 1.10.2 | `2024-11-05` | works, negotiates `2024-11-05` |
| SDK 1.13.3 | `2025-06-18` | works |
| SDK 1.23.0 | `2025-06-18` | works |
| SDK 1.30.1 (latest published) | `2025-11-25` | works |

The `2026-07-28` path is tested against requests written to the specification; at the time of writing no
published TypeScript SDK client speaks that revision yet.

**Not supported: the HTTP+SSE transport** (a `GET /sse` stream plus a separate `POST` endpoint), which
Streamable HTTP replaced in `2025-03-26`. Clients that only have that transport — the TypeScript SDK
before 1.10, and SSE-only tools — will not connect. Serving it would need a long-lived stream correlated
with later `POST`s, which on Workers means Durable Objects; the transport is deprecated in the current
specification, so it has been left out.

### Connecting an MCP client

The token goes in a header, so any client that supports Streamable HTTP with custom headers works.

**Claude Code**

```bash
claude mcp add --transport http jev https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer $JEV_TOKEN"
```

Using `$JEV_TOKEN` keeps the value out of your shell history, but at the time of writing
`claude mcp add` still prints the header value to stdout
([claude-code#78707](https://github.com/anthropics/claude-code/issues/78707)), so do not run it inside a
recorded terminal or an agent session. The command stores the token in Claude Code's configuration file in
clear text; the Claude Code MCP documentation describes `headersHelper`, which fetches headers from a
command at connect time and so lets the token live in a secrets manager instead.

**Clients that only launch local (stdio) servers**, such as Claude Desktop's config file, can reach it
through `mcp-remote`:

```json
{
  "mcpServers": {
    "jev": {
      "command": "npx",
      "args": ["mcp-remote", "https://<your-worker>.workers.dev/mcp",
               "--header", "Authorization:${JEV_AUTH}"],
      "env": { "JEV_AUTH": "Bearer <token>" }
    }
  }
}
```

Keeping the value in `env` rather than in `args` keeps the token out of process listings, and the
missing space after `Authorization:` avoids an argument-splitting problem some clients have with spaces
inside `args`.

Clients that only support OAuth for remote servers cannot supply a static bearer token and will not
connect. The worker deliberately returns 404 rather than 401 on a bad token, so it also does not start
an OAuth discovery flow.

### Deploying

There is no `wrangler.toml` in the repo. Create one next to `worker.js`:

```toml
name = "jev"
main = "worker.js"
compatibility_date = "2026-07-01"

[ai]
binding = "AI"

# optional
[vars]
# ALLOWED_ORIGINS = "https://your-ui.example"   # restrict browser callers
# MAX_BODY_BYTES = "1048576"                     # request body cap, default 1 MiB
# SOURCE_URL = "https://github.com/you/fork"     # if you deploy a modified copy
```

Then set the secret and publish:

```bash
npx wrangler secret put AUTHN     # paste the token clients will send
npx wrangler deploy
```

`crypto.subtle.timingSafeEqual` is a Workers extension rather than standard WebCrypto. It is available at
every compatibility date (checked back to `2021-11-03`, the earliest), so no particular date is needed for
the auth path. Do not set a date newer than your local Wrangler's runtime supports: `wrangler dev` will
fail to start, although production would accept it.

| Name | Kind | Required | Purpose |
|---|---|---|---|
| `AI` | binding | yes | Workers AI |
| `AUTHN` | secret | yes | The bearer token both routes accept |
| `ALLOWED_ORIGINS` | var | no | Comma-separated. When set, a browser request from an unlisted origin gets the same bare 404 and CORS echoes the allowed origin instead of `*`. Requests without an `Origin` header (curl, server-side MCP clients) are left to the token. |
| `MAX_BODY_BYTES` | var | no | Request body cap for both routes. Default 1 MiB. |
| `SOURCE_URL` | var | no | Where the corresponding source lives. See [Licence](#licence). |

### Calling it directly

```bash
curl -sS https://<your-worker>.workers.dev/ \
  -H "Authorization: Bearer $JEV_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "state": "Help! My payouts have been failing for 3 days.",
        "questions": {
          "is_urgent": {
            "type": "noul",
            "instructions": "Does this convey urgency?"
          }
        }
      }'
```

```json
{
  "model": "jev-1.13.0",
  "answers": { "is_urgent": { "type": "noul", "noul": 0.95 } },
  "usage": { "input_tokens": 296, "output_tokens": 20 }
}
```

The same call through MCP:

```bash
curl -sS https://<your-worker>.workers.dev/mcp \
  -H "Authorization: Bearer $JEV_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"jev_evaluate",
        "arguments":{"state":"Help! My payouts have been failing for 3 days.",
                     "questions":{"is_urgent":{"type":"noul","instructions":"Does this convey urgency?"}}}}}'
```

A `404` with an empty body almost always means the token did not match, not that the URL is wrong. With
Claude Code, if `/mcp` shows the server connected but tool calls fail, check whether your version attaches
the configured header on every request ([claude-code#50464](https://github.com/anthropics/claude-code/issues/50464)
reported one that did not); this worker answers a missing header with the same bare 404.

---

## index.html

One file, no build, no dependencies to install. Open it in a browser, or serve it over HTTP to get the
saved library (see [Storage](#storage)). Point it at your worker URL, paste the bearer token, and run.

**Writing a request**

- **State** — the content to judge. Three interchangeable editors: a JSON tree builder, plain text, and raw
  JSON. Text mode sends a JSON string, which is what the API expects for unstructured content.
- **Questions** — a builder for the three question types, plus a `raw` type that sends whatever JSON you
  type for probing the API or for a shape the builder does not model:
  - **Noul** — yes/no, answered as a probability, with optional `true`/`false` criteria.
  - **Choice** — one option from a set you define, up to 255.
  - **Score** — a position along ordered levels, 2 to 10 of them.
- **Generate** builds one question per item from a template, for fanning a single question across a list.
- Validation runs as you type: duplicate ids, empty criteria, broken references, a token budget estimate
  and a cost estimate, and a check for card numbers and other secrets in the state before anything leaves
  the browser.

**Reading answers**

- Every answer shows its value, its probability distribution, and the **band** it falls into.
- **Thresholds** are bands you define: an ordered list of cut-offs, each with a name and a colour, plus a
  floor for everything below them. An answer takes the first band it reaches, counting down. Two bands and
  a floor (`act` / `review` / `hold`) is the default; you can have as many as you want. Set them globally,
  or give any single question its own set.
  These are read in the browser and **never sent** — they exist to show you what your own code would do
  with the numbers. Noul strength is `max(p, 1-p)`; Choice and Score use the returned `confidence`.
- **Runs** keeps the history for the tab. Mark any two runs **A** and **B** to diff them answer by answer.
- **Repeat** a request N times to see the spread: mean, standard deviation, range, and whether any answer
  flipped bands between runs. Useful for deciding whether a threshold sits somewhere stable.
- **Matrix** puts repeats side by side and exports to CSV.
- **Payload** and **Raw** show exactly what was sent and exactly what came back.

**Library**

Saved URLs, bearer tokens, states, question sets, runs, and threshold sets. Any of them can be marked as
the default that loads in a new tab. Everything imports and exports as JSON, so a set-up moves between
browsers as a file.

The file ships with worked examples across four workflows — security incident triage, customer service,
agent trace review, and invoice processing — each with the states, the question sets, and Jev's published
answers for them. Those examples are read-only in the library: renaming or deleting one would break the
runs that point at it by name. Save your own copy under a different name instead.

Thresholds save two ways: inside a question set, and as records of their own when you want one set of
bands across several question sets.

### Content-Security-Policy

The page carries a CSP in a `<meta>` tag. Scripts are pinned to the SHA-256 hash of the one inline script,
so injected code does not run, whether it is an external `<script>`, an inline one, an inline event
handler, a `javascript:` link, or `eval` and `new Function`. Images and CSS `url()` fetches are limited to `data:` URLs, so a crafted value cannot turn into a
tracking beacon.

Two parts are deliberately loose, and worth knowing:

- `connect-src` allows any `https:` host, plus `http://localhost` and `http://127.0.0.1`, because the worker
  URL is whatever you type. The CSP therefore does not stop data leaving over HTTPS; its protection comes
  from stopping the injected code that would send it. A worker on another machine over plain HTTP, such as
  `http://192.168.1.5:8787`, is blocked: use HTTPS or a tunnel.
- `style-src` allows inline styles, because the interface sets `style` attributes as it renders. The band
  colours that reach those attributes are validated as `#rrggbb` before use.

**If you edit the script, recompute the hash** and replace the `sha256-…` value in the `<meta>` tag, or the
page will load blank with a CSP error in the console:

```bash
node -e 'const s=require("fs").readFileSync("index.html","utf8").match(/<script>([\s\S]*?)<\/script>/)[1];
console.log("sha256-"+require("crypto").createHash("sha256").update(s,"utf8").digest("base64"))'
```

Verified in headless Chrome 153: the page runs with no violations. Every library tab renders, a live inference
round-trip to the worker works, and downloads work. Injected scripts, inline handlers, `javascript:` links, `eval`,
image and CSS beacons, and plain-HTTP exfiltration were all blocked before leaving the browser.

### Storage

Everything is local. The page contacts nothing except the worker URL you enter: the Inter font is embedded
in the file rather than fetched from Google Fonts, so opening the page discloses nothing to a third party.

- The **library** uses IndexedDB, which may be unavailable or isolated on `file://` pages depending on the
  browser. Where it is, the page keeps saved items in memory for that tab only. For a dependable library,
  serve the file over HTTP:
  ```bash
  python3 -m http.server 8000     # then open http://localhost:8000/index.html
  ```
  Export and Import work either way, so you can move things as files without a server.
- The **draft** and the **run history** use `sessionStorage` and are gone when the tab closes.
- **Bearer tokens are stored unencrypted** and are readable by any script on the same origin. Use
  short-lived, least-privilege tokens here.

---

## Security notes

- The token is the only access control on either route, and CORS is open to every origin unless
  `ALLOWED_ORIGINS` is set. Anyone holding the token can spend your Workers AI quota, through the HTTP
  route or through MCP. Rotate it with `wrangler secret put AUTHN`; there is no revocation list.
- An MCP client configuration stores the token on the machine running the client. Treat those files like
  any other credential store, and prefer short-lived tokens where the client allows it.
- Every refusal before the body is parsed returns a bare 404, and the CORS preflight echoes only the
  headers a browser asks about, so a scanner learns neither the routes nor the protocols served. It can
  still tell that *something* answers CORS on the host; that is unavoidable for a browser-callable API.
  Keep the 404 behaviour if you modify the worker — returning 401 for a bad token turns it into an oracle
  for valid ones.
- Request bodies are counted as they stream and refused the moment they pass the cap, so a chunked upload
  with no `Content-Length` cannot make the worker buffer more than the limit.
- The token check hashes both sides before a constant-time compare, so it does not leak the token's
  length. The original compared raw strings and returned early on a length mismatch.
- `ALLOWED_ORIGINS` is the DNS-rebinding and cross-origin control the MCP transport asks servers to
  apply. It is off by default because the tester UI can be opened from anywhere, including `file://`.
  Turn it on once you know where the UI is served from.
- The UI's CSP blocks injected code but, by necessity, not HTTPS connections to arbitrary hosts; see
  [Content-Security-Policy](#content-security-policy).
- The worker does not rate limit. If the URL is public, put a
  [Cloudflare rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) in front of it.
- The UI warns before sending a state that looks like it contains card numbers or credentials, but it is a
  heuristic, not a guarantee, and the MCP route has no such check. Do not send production secrets.

## Licence

Licensed under the **GNU Affero General Public License v3.0 or later** (`AGPL-3.0-or-later`); see
`LICENSE`. `worker.js` carries the matching SPDX identifier and licence notice.

The AGPL's section 13 applies to network use: if you run a **modified** version for other people over a
network, you must offer them its source. The worker does this on every authenticated response with a
`Link: <SOURCE_URL>; rel="source"` header, which defaults to this repository. If you deploy a modified
copy, set `SOURCE_URL` to where your modified source is published.

`index.html` embeds the Inter typeface, which is licensed separately under the **SIL Open Font License
1.1** (© 2016 The Inter Project Authors). The OFL permits bundling a font with software; the copyright
notice and licence reference sit beside the embedded font in the page's CSS.

This section describes how the code is set up; it is not legal advice. Questions about licence
obligations — including the choice between `-or-later` and `-only`, and bundling an OFL font inside an
AGPL work — belong with your legal team.

## Credits

© [KSEC — Erez Kalman](https://www.kalman.co.il)

Jev and the System One models are TypeSafe's; see [docs.typesafe.ai](https://docs.typesafe.ai).

The [Inter](https://github.com/rsms/inter) typeface is © The Inter Project Authors, under the SIL Open Font
License 1.1.
