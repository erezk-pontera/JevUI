// =============================================
// /src/worker.js
// =============================================
// Author: Erez Kalman - KSEC License: AGPL-3.0

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

/**
 * Constant-time string comparison to prevent timing side-channels.
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  return crypto.subtle.timingSafeEqual(aBuf, bBuf);
}

export default {
  async fetch(request, env) {
    // Handle CORS Preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. Method verification: Silent 404 for non-POST
    if (request.method !== 'POST') {
      return new Response(null, { status: 404, headers: corsHeaders });
    }

    // 2. Authentication verification: Bearer token against env.AUTHN
    const authHeader = request.headers.get('Authorization') || '';
    const expectedToken = env.AUTHN;

    if (!expectedToken || !authHeader.startsWith('Bearer ')) {
      return new Response(null, { status: 404, headers: corsHeaders });
    }

    const token = authHeader.slice(7).trim();
    if (!timingSafeEqual(token, expectedToken)) {
      return new Response(null, { status: 404, headers: corsHeaders });
    }

    // 3. Payload parsing & validation
    let payload;
    try {
      payload = await request.json();
    } catch (parseError) {
      return Response.json(
        {
          error: "Invalid JSON format",
          details: parseError.message || "Failed to parse request body as JSON"
        },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return Response.json(
        {
          error: "Invalid payload schema",
          details: "Body must be a JSON object containing execution parameters."
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // 4. Model execution
    try {
      const response = await env.AI.run('typesafe/jev', payload);
      return Response.json(response, { headers: corsHeaders });
    } catch (modelError) {
      console.error("AI model execution failed:", modelError);
      return Response.json(
        {
          error: "Inference execution failed",
          details: modelError.message || String(modelError)
        },
        { status: 500, headers: corsHeaders }
      );
    }
  }
};
