# JevUI

A browser tester for [TypeSafe Jev](https://docs.typesafe.ai), served through a Cloudflare Worker that
holds your credentials so the page never has to.

Jev answers structured questions about a piece of content. You send a `state` (the thing to judge) and a
map of `questions`, and you get one typed answer per question: a probability for yes/no, a chosen option,
or a position on a scale. This repo gives you somewhere to write those requests by hand, run them, and
read the answers without wiring anything up first.

```
worker.js     Cloudflare Worker: auth, validation, and the call to the model
index.html    the tester UI, one self-contained file, no build step
```

---

## worker.js

A Workers AI proxy in front of `typesafe/jev`. It exists so the model binding and the shared secret stay
on the server side, and so a static page can call it from anywhere.

**What it does, in order:**

1. **`OPTIONS`** returns the CORS preflight headers and nothing else.
2. **Anything other than `POST`** returns an empty **404**.
3. **Auth.** Reads `Authorization: Bearer <token>` and compares it to the `AUTHN` secret with
   `crypto.subtle.timingSafeEqual`, so the comparison takes the same time whether the first byte is wrong
   or the last one is. A missing header, a missing secret, or a wrong token all return an empty **404** —
   deliberately the same answer as a wrong method, so probing the endpoint tells you nothing about whether
   it exists or whether a token was close.
4. **Body.** Must parse as JSON and be a plain object; an array or a scalar is rejected. Failures return
   **400** with `{ error, details }`.
5. **Inference.** Calls `env.AI.run('typesafe/jev', payload)` and returns the model's response as JSON.
   A model or binding failure returns **500** with `{ error, details }` and logs the cause.

The body is passed to the model untouched, so the worker does not need changing when the request schema
gains a field.

**CORS** is `Access-Control-Allow-Origin: *`, methods `POST, OPTIONS`, headers `Content-Type, Authorization`,
preflight cached for 24 hours. Any origin may call the worker; the bearer token is the only thing standing
in front of it, so treat it as the whole of your access control and rotate it like a password.

### Deploying

There is no `wrangler.toml` in the repo. Create one next to `worker.js`:

```toml
name = "jev"
main = "worker.js"
compatibility_date = "2024-09-23"

[ai]
binding = "AI"
```

Then set the secret and publish:

```bash
npx wrangler secret put AUTHN     # paste the token the UI will send
npx wrangler deploy
```

`compatibility_date` needs to be recent enough for `crypto.subtle.timingSafeEqual`, which is a Workers
extension rather than standard WebCrypto. If deploys fail on that call, move the date forward.

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

A `404` with an empty body almost always means the token did not match, not that the URL is wrong.

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

### Storage

Everything is local. Nothing is sent anywhere except the request itself, to the worker URL you enter.

- The **library** uses IndexedDB, which browsers block on `file://` pages. Opening the file directly still
  works, but saved items live in memory for that tab only. For a real library, serve it over HTTP:
  ```bash
  python3 -m http.server 8000     # then open http://localhost:8000/index.html
  ```
  Export and Import work either way, so you can move things as files without a server.
- The **draft** and the **run history** use `sessionStorage` and are gone when the tab closes.
- **Bearer tokens are stored unencrypted** and are readable by any script on the same origin. Use
  short-lived, least-privilege tokens here.

---

## Security notes

- The token is the only access control on the worker, and CORS is open to every origin. Anyone holding it
  can spend your Workers AI quota. Rotate it with `wrangler secret put AUTHN`; there is no revocation list.
- Every rejection before the body is parsed returns a bare 404, so the endpoint gives nothing away to a
  scanner. Keep that behaviour if you modify the worker — returning 401 for a bad token turns it into an
  oracle for valid ones.
- The worker does not rate limit. If the URL is public, put a
  [Cloudflare rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) in front of it.
- The UI warns before sending a state that looks like it contains card numbers or credentials, but it is a
  heuristic, not a guarantee. Do not paste production secrets into it.

## Licence

The repository is licensed under **AGPL-3.0** (see `LICENSE`).

## Credits

© [KSEC — Erez Kalman](https://www.kalman.co.il)

Jev and the System One models are TypeSafe's; see [docs.typesafe.ai](https://docs.typesafe.ai).
