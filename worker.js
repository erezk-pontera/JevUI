// SPDX-License-Identifier: AGPL-3.0-or-later
//
// JevUI worker: a Cloudflare Workers AI proxy for TypeSafe Jev, with an MCP endpoint.
// Copyright (C) 2026 Erez Kalman - KSEC <https://www.kalman.co.il>
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License along
// with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Corresponding source: https://github.com/kaerez/JevUI
// AGPL section 13 asks that users interacting with a modified version over a network
// be offered its source. Every authenticated response carries a Link header with
// rel="source" pointing at SOURCE_URL; if you deploy a modified copy, set SOURCE_URL
// to where your modified source lives.

// ---------------------------------------------------------------------------
// Routes
//
//   POST /       the original endpoint: the body goes to typesafe/jev untouched
//   POST /mcp    Model Context Protocol over Streamable HTTP, one tool: jev_evaluate
//   OPTIONS *    CORS preflight
//
// Both routes share one gate: Authorization: Bearer <AUTHN>. Every rejection before
// the gate is passed is a bare 404, identical to an unknown path, so a scanner learns
// nothing about whether the endpoint exists or whether a token was close.
//
// Bindings and variables
//   AI               Workers AI binding (required)
//   AUTHN            the shared bearer token, as a secret (required)
//   ALLOWED_ORIGINS  optional, comma-separated. When set, a request whose Origin is
//                    not listed is refused, and CORS echoes the allowed origin
//                    instead of "*". Unset keeps the original open CORS.
//   MAX_BODY_BYTES   optional request body cap, default 1 MiB
//   SOURCE_URL       optional, where the corresponding source lives (AGPL s.13)
// ---------------------------------------------------------------------------

const MODEL = "typesafe/jev";
const MCP_PATH = "/mcp";
const DEFAULT_SOURCE_URL = "https://github.com/kaerez/JevUI";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
// A batch is one HTTP request that can ask for many model calls, so it is capped:
// otherwise a single request would sidestep any per-request rate limit in front.
const MAX_BATCH = 16;

const SERVER_INFO = {
  name: "jevui-worker",
  title: "TypeSafe Jev",
  version: "2.0.0",
};

// MCP revisions. 2026-07-28 is stateless: no initialize handshake, and every request
// names its version in params._meta. The earlier revisions negotiate once through
// initialize. Both are served, per request, by whichever shape the request uses.
//
// 2024-11-05 is listed because clients exist that speak Streamable HTTP but still open
// with it (the TypeScript SDK up to 1.12 does). Everything this server uses exists in
// that revision; the newer fields it sends (annotations, structuredContent, title) are
// extra keys an older client ignores, and the answer is always in the text content too.
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];

const META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  serverInfo: "io.modelcontextprotocol/serverInfo",
};

// JSON-RPC and MCP error codes.
const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,        // 2026-07-28
  unsupportedVersion: -32022,    // 2026-07-28
};

// Methods the 2026-07-28 revision removed. A modern request for one of them is a
// method-not-found, not a silent fallback to the handshake behaviour.
const REMOVED_IN_MODERN = new Set(["initialize", "ping", "logging/setLevel", "notifications/initialized"]);

const INSTRUCTIONS =
  "Jev answers structured questions about a piece of content. Call jev_evaluate with a `state` " +
  "(the content to judge: text, or a JSON object or array) and a `questions` map keyed by question id. " +
  "Each question has a `type` of noul (yes/no, answered as a probability), choice (one of the options " +
  "named in `criteria`) or score (a position along ordered levels), plus `instructions`. Answers come " +
  "back keyed by the same ids. Question schema: https://docs.typesafe.ai";

const JEV_TOOL = {
  name: "jev_evaluate",
  title: "Evaluate content with Jev",
  description:
    "Ask TypeSafe Jev one or more structured questions about a piece of content and get one typed " +
    "answer per question. noul returns a probability that the statement is true; choice returns the " +
    "chosen option with a confidence; score returns a position along the levels with a confidence. " +
    "Nothing is stored between calls, and repeated calls on the same input can differ slightly.",
  inputSchema: {
    type: "object",
    properties: {
      state: {
        description:
          "The content to judge. A string for free text, or a JSON object or array for structured " +
          "data. Refer to parts of it from a question by path, e.g. `recommendation.next_step`.",
        anyOf: [{ type: "string" }, { type: "object" }, { type: "array" }],
      },
      questions: {
        type: "object",
        description:
          "Questions keyed by an id of your choosing. Example: {\"is_urgent\": {\"type\": \"noul\", " +
          "\"instructions\": \"Does this convey urgency?\"}}",
        minProperties: 1,
        additionalProperties: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["noul", "choice", "score"] },
            instructions: { type: "string" },
            criteria: { type: "object" },
          },
          required: ["type", "instructions"],
        },
      },
    },
    required: ["state", "questions"],
    additionalProperties: false,
  },
  annotations: {
    title: "Evaluate content with Jev",
    readOnlyHint: true,      // reads the input, changes nothing
    destructiveHint: false,
    idempotentHint: false,   // model output can vary between identical calls
    openWorldHint: false,    // talks to one fixed model, not the open internet
  },
};

// ---------------------------------------------------------------------------
// Shared: CORS, origin policy, authentication, body reading
// ---------------------------------------------------------------------------

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The headers a preflight may allow. The browser's own list is echoed back, so an
 *  unauthenticated OPTIONS no longer publishes which protocol headers this worker
 *  understands; only plain header-name characters are echoed. */
function allowedRequestHeaders(request) {
  const asked = request.headers.get("Access-Control-Request-Headers") || "";
  return /^[A-Za-z0-9-]+(\s*,\s*[A-Za-z0-9-]+)*$/.test(asked.trim()) ? asked.trim() : "Content-Type, Authorization";
}

/** CORS headers for this request. Open by default, as the original worker was. */
function corsHeadersFor(request, env) {
  const list = allowedOrigins(env);
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": allowedRequestHeaders(request),
    "Access-Control-Max-Age": "86400",
    "Vary": "Access-Control-Request-Headers",
  };
  if (!list.length) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (origin && list.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin, Access-Control-Request-Headers";
  }
  return headers;
}

/** False only when an allowlist is set and the request's Origin is not on it.
 *  Requests without an Origin (curl, server-side MCP clients) are not browsers
 *  and are left to the bearer check. */
function originPermitted(request, env) {
  const list = allowedOrigins(env);
  if (!list.length) return true;
  const origin = request.headers.get("Origin");
  return !origin || list.includes(origin);
}

/**
 * Constant-time token check. Both sides are hashed first, so the comparison always
 * runs over two 32-byte digests: unlike comparing the raw strings, a length
 * mismatch no longer returns early and so no longer leaks the token's length.
 */
async function tokenMatches(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string" || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(presented)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function authenticated(request, env) {
  const header = request.headers.get("Authorization") || "";
  // The scheme name is case-insensitive (RFC 7235 s.2.1); the token is not.
  if (!env.AUTHN || header.slice(0, 7).toLowerCase() !== "bearer ") return false;
  return tokenMatches(header.slice(7).trim(), env.AUTHN);
}

/** Drop trailing slashes in one linear pass. The obvious /\/+$/ backtracks
 *  quadratically on a long run of slashes followed by anything else: a 16 KB path
 *  cost about 285 ms of CPU in workerd. */
function trimTrailingSlashes(path) {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end--;
  return path.slice(0, end);
}

/** An ID to quote when reporting a failure: Cloudflare's own ray ID where there is
 *  one, so the log line and the edge logs agree, otherwise a fresh random one. */
function requestIdFor(request) {
  const ray = request.headers.get("cf-ray");
  return ray && /^[A-Za-z0-9-]{1,64}$/.test(ray) ? ray : crypto.randomUUID();
}

/** A bare 404: the one answer every unauthorised or unknown request gets. */
function notFound(cors) {
  return new Response(null, { status: 404, headers: cors });
}

/** Read the body as text, refusing anything over the cap before parsing it. */
async function readBody(request, env) {
  const limit = Number(env.MAX_BODY_BYTES) > 0 ? Number(env.MAX_BODY_BYTES) : DEFAULT_MAX_BODY_BYTES;
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) return { tooLarge: true, limit };
  if (!request.body) return { text: "" };
  // A chunked body has no Content-Length to check up front, so count as it streams
  // and stop the moment it passes the cap, rather than holding all of it in memory.
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return { tooLarge: true, limit };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.byteLength; }
  return { text: new TextDecoder().decode(buf) };   // same UTF-8 decoding as request.text()
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function runJev(env, payload) {
  if (!env.AI || typeof env.AI.run !== "function") {
    throw new Error("The AI binding is not configured on this worker");
  }
  return env.AI.run(MODEL, payload);
}

// ---------------------------------------------------------------------------
// POST /  - the original endpoint, behaviour unchanged apart from the body cap
// ---------------------------------------------------------------------------

async function handleInference(request, env, headers) {
  const body = await readBody(request, env);
  if (body.tooLarge) {
    return Response.json(
      { error: "Payload too large", details: "Request body exceeds " + body.limit + " bytes." },
      { status: 413, headers }
    );
  }

  let payload;
  try {
    payload = JSON.parse(body.text);
  } catch (parseError) {
    return Response.json(
      { error: "Invalid JSON format", details: parseError.message || "Failed to parse request body as JSON" },
      { status: 400, headers }
    );
  }

  if (!isPlainObject(payload)) {
    return Response.json(
      { error: "Invalid payload schema", details: "Body must be a JSON object containing execution parameters." },
      { status: 400, headers }
    );
  }

  try {
    return Response.json(await runJev(env, payload), { headers });
  } catch (modelError) {
    // The underlying message can name internal hosts or configuration, so it goes
    // to the log only, under an ID the caller can quote. The payload is never
    // logged: it may carry customer data.
    const requestId = requestIdFor(request);
    console.error("AI model execution failed [" + requestId + "]:", modelError && modelError.message);
    return Response.json(
      { error: "Inference execution failed",
        details: "The model could not process this request. Quote the request ID when reporting it.",
        requestId },
      { status: 500, headers }
    );
  }
}

// ---------------------------------------------------------------------------
// POST /mcp  - Model Context Protocol, stateless Streamable HTTP, JSON responses
// ---------------------------------------------------------------------------

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

/** Every 2026-07-28 result carries resultType and names the server in _meta. */
function modern(result) {
  return {
    resultType: "complete",
    ...result,
    _meta: { ...(result._meta || {}), [META.serverInfo]: SERVER_INFO },
  };
}

function toolsListResult(isModern) {
  const base = { tools: [JEV_TOOL] };
  if (!isModern) return base;
  // Cacheable list results must say for how long, and for whom. The list sits
  // behind the bearer token, so shared intermediaries must not cache it.
  return modern({ ...base, ttlMs: 60 * 60 * 1000, cacheScope: "private" });
}

function discoverResult() {
  return modern({
    supportedVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: { listChanged: false } },
    instructions: INSTRUCTIONS,
    ttlMs: 60 * 60 * 1000,
    cacheScope: "private",
  });
}

function initializeResult(requested) {
  // The handshake belongs to the earlier revisions, so it only ever settles on one
  // of them; a client asking for a version it does not know gets the newest.
  const version = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
}

/** Check the arguments well enough to give the model an actionable message; the
 *  question schema itself is Jev's to enforce. */
function validateArguments(args) {
  if (!isPlainObject(args)) return "Arguments must be an object with `state` and `questions`.";
  const extra = Object.keys(args).filter((k) => k !== "state" && k !== "questions");
  if (extra.length) return "Unexpected argument(s): " + extra.join(", ") + ". Only `state` and `questions` are accepted.";

  const s = args.state;
  if (s === undefined || s === null) return "`state` is required: the text or JSON the questions are about.";
  if (typeof s === "string" ? !s.trim() : typeof s !== "object") {
    return "`state` must be a non-empty string, or a JSON object or array.";
  }

  const q = args.questions;
  if (!isPlainObject(q) || !Object.keys(q).length) {
    return "`questions` must be an object with at least one question, keyed by an id you choose.";
  }
  for (const [id, def] of Object.entries(q)) {
    if (!isPlainObject(def)) return "Question `" + id + "` must be an object.";
    if (!["noul", "choice", "score"].includes(def.type)) {
      return "Question `" + id + "` needs `type` set to noul, choice or score.";
    }
    if (typeof def.instructions !== "string" || !def.instructions.trim()) {
      return "Question `" + id + "` needs non-empty `instructions`.";
    }
  }
  return null;
}

/** A tool failure the model can read and correct, rather than a protocol error. */
function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function callTool(env, params, request) {
  const args = params.arguments;
  const problem = validateArguments(args);
  if (problem) return toolError(problem);
  try {
    const response = await runJev(env, { state: args.state, questions: args.questions });
    return {
      content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      structuredContent: response,
      isError: false,
    };
  } catch (e) {
    // Same rule as POST /: the detail is logged, the caller gets an ID to quote.
    // Argument problems above stay specific, since those messages are this
    // worker's own and help the calling model correct itself.
    const requestId = requestIdFor(request);
    console.error("MCP jev_evaluate failed [" + requestId + "]:", e && e.message);
    return toolError("Jev could not evaluate this input. Request ID " + requestId + ".");
  }
}

/**
 * Handle one JSON-RPC message. Returns { status, body } where body is null for a
 * notification, which Streamable HTTP answers with 202 and nothing else.
 */
async function dispatch(msg, request, env) {
  if (!isPlainObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { status: 400, body: rpcError(msg && msg.id, ERR.invalidRequest, "Invalid JSON-RPC request") };
  }
  const { id, method } = msg;
  const params = isPlainObject(msg.params) ? msg.params : {};
  const isNotification = id === undefined;
  const meta = isPlainObject(params._meta) ? params._meta : {};
  const requested = meta[META.protocolVersion];
  const isModern = typeof requested === "string";

  // server/discover answers any caller, with or without _meta: it is how a client
  // that does not yet know this server works out which revision to speak.
  if (method === "server/discover" && !isModern) {
    return { status: 200, body: rpcResult(id, discoverResult()) };
  }

  if (isModern) {
    if (requested !== MODERN_VERSION) {
      return { status: 400, body: rpcError(id, ERR.unsupportedVersion, "Unsupported protocol version",
                                           { supported: SUPPORTED_VERSIONS, requested }) };
    }
    // Headers that restate the body must agree with it.
    const hVersion = request.headers.get("MCP-Protocol-Version");
    const hMethod = request.headers.get("Mcp-Method");
    const hName = request.headers.get("Mcp-Name");
    if (hVersion && hVersion !== requested) {
      return { status: 400, body: rpcError(id, ERR.headerMismatch, "MCP-Protocol-Version header does not match _meta") };
    }
    if (hMethod && hMethod !== method) {
      return { status: 400, body: rpcError(id, ERR.headerMismatch, "Mcp-Method header does not match the request method") };
    }
    if (hName && method === "tools/call" && hName !== params.name) {
      return { status: 400, body: rpcError(id, ERR.headerMismatch, "Mcp-Name header does not match the tool name") };
    }
    if (REMOVED_IN_MODERN.has(method)) {
      return { status: 200, body: isNotification ? null
        : rpcError(id, ERR.methodNotFound, method + " is not part of protocol version " + MODERN_VERSION) };
    }
    if (method !== "server/discover" && !isPlainObject(meta[META.clientCapabilities])) {
      return { status: 200, body: isNotification ? null
        : rpcError(id, ERR.invalidParams, "params._meta must include " + META.clientCapabilities) };
    }
  } else {
    // An earlier-revision client sends the version it negotiated as a header;
    // one this server never offered is a bad request.
    const hVersion = request.headers.get("MCP-Protocol-Version");
    if (hVersion && !SUPPORTED_VERSIONS.includes(hVersion)) {
      return { status: 400, body: rpcError(id, ERR.unsupportedVersion, "Unsupported protocol version",
                                           { supported: SUPPORTED_VERSIONS, requested: hVersion }) };
    }
  }

  // Notifications carry no reply. initialized, cancelled and the rest need no work
  // here: nothing is long-running and there is no session to update.
  if (isNotification) return { status: 202, body: null };

  switch (method) {
    case "server/discover":
      return { status: 200, body: rpcResult(id, discoverResult()) };

    case "initialize":
      return { status: 200, body: rpcResult(id, initializeResult(params.protocolVersion)) };

    case "ping":
      return { status: 200, body: rpcResult(id, {}) };

    case "tools/list":
      return { status: 200, body: rpcResult(id, toolsListResult(isModern)) };

    case "tools/call": {
      if (params.name !== JEV_TOOL.name) {
        return { status: 200, body: rpcError(id, ERR.invalidParams, "Unknown tool: " + params.name) };
      }
      const result = await callTool(env, params, request);
      return { status: 200, body: rpcResult(id, isModern ? modern(result) : result) };
    }

    default:
      return { status: 200, body: rpcError(id, ERR.methodNotFound, "Method not found: " + method) };
  }
}

async function handleMcp(request, env, headers) {
  if (request.method !== "POST") {
    // No server-to-client stream and no sessions: GET and DELETE have nothing to do.
    return new Response(null, { status: 405, headers: { ...headers, Allow: "POST, OPTIONS" } });
  }

  const json = { ...headers, "Content-Type": "application/json" };
  const body = await readBody(request, env);
  if (body.tooLarge) {
    return new Response(JSON.stringify(rpcError(null, ERR.invalidRequest, "Request body exceeds " + body.limit + " bytes")),
                        { status: 413, headers: json });
  }

  let msg;
  try {
    msg = JSON.parse(body.text);
  } catch (e) {
    return new Response(JSON.stringify(rpcError(null, ERR.parse, "Parse error: " + e.message)),
                        { status: 400, headers: json });
  }

  // Batches: 2025-03-26 requires servers to accept them; 2025-06-18 and later removed
  // them. They are accepted here so 2025-03-26 clients work, and answered as JSON-RPC
  // says: an array of the responses, leaving out notifications.
  if (Array.isArray(msg)) {
    if (!msg.length) {
      return new Response(JSON.stringify(rpcError(null, ERR.invalidRequest, "Empty batch")),
                          { status: 400, headers: json });
    }
    if (msg.length > MAX_BATCH) {
      return new Response(JSON.stringify(rpcError(null, ERR.invalidRequest, "Batch exceeds " + MAX_BATCH + " messages")),
                          { status: 400, headers: json });
    }
    try {
      const outs = [];
      for (const m of msg) {            // in order, one at a time, not N model calls at once
        const { body: out } = await dispatch(m, request, env);
        if (out !== null) outs.push(out);
      }
      if (!outs.length) return new Response(null, { status: 202, headers });
      return new Response(JSON.stringify(outs), { status: 200, headers: json });
    } catch (e) {
      console.error("MCP batch dispatch failed:", e && e.message);
      return new Response(JSON.stringify(rpcError(null, ERR.internal, "Internal error")),
                          { status: 500, headers: json });
    }
  }

  try {
    const { status, body: out } = await dispatch(msg, request, env);
    if (out === null) return new Response(null, { status: 202, headers });
    return new Response(JSON.stringify(out), { status, headers: json });
  } catch (e) {
    console.error("MCP dispatch failed:", e && e.message);
    return new Response(JSON.stringify(rpcError(msg && msg.id, ERR.internal, "Internal error")),
                        { status: 500, headers: json });
  }
}

// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const cors = corsHeadersFor(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // One gate for both routes. Every refusal here looks like an unknown path.
    if (!originPermitted(request, env)) return notFound(cors);
    if (!(await authenticated(request, env))) return notFound(cors);

    // Past the gate, the caller is interacting with the program, so offer the source.
    const headers = { ...cors, Link: "<" + (env.SOURCE_URL || DEFAULT_SOURCE_URL) + '>; rel="source"' };

    const path = trimTrailingSlashes(new URL(request.url).pathname) || "/";
    if (path === MCP_PATH) return handleMcp(request, env, headers);
    if (request.method === "POST") return handleInference(request, env, headers);
    return notFound(headers);
  },
};
