// Stateless JSON-RPC 2.0 dispatcher for MCP over Bun.serve fetch API.
// Handles: initialize, notifications/initialized, tools/list, tools/call.
// No SDK transport — direct function dispatch into mcp-tools.ts.
// WHY: StreamableHTTPServerTransport expects Node http.ServerResponse (res.writeHead),
//      incompatible with Bun.serve's WHATWG fetch API. Hand-rolling is cleaner and
//      fully controllable for our stateless request/response use case.

import { checkAuth } from "./auth.ts"
import { TOOLS } from "./mcp-tools.ts"

// ---- Tool registry ----------------------------------------------------------

export interface ToolParam {
  type: string
  description?: string
  properties?: Record<string, ToolParam>
  required?: string[]
  [k: string]: unknown
}

export interface ToolDef {
  name: string
  description: string
  inputSchema: { type: "object"; properties: Record<string, ToolParam>; required?: string[] }
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]))

// ---- Server info (returned in initialize response) --------------------------

const SERVER_INFO = {
  name: "keel",
  version: "0.1.0",
}

const CAPABILITIES = {
  tools: {},
}

const PROTOCOL_VERSION = "2024-11-05"

// ---- JSON-RPC helpers -------------------------------------------------------

function ok(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { status: 200 })
}

function rpcErr(id: unknown, code: number, message: string, data?: unknown): Response {
  return Response.json(
    { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } },
    { status: 200 } // JSON-RPC errors are still HTTP 200
  )
}

// ---- Main dispatcher --------------------------------------------------------

export async function handleMcp(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("MCP endpoint requires POST", { status: 405 })
  }

  const authReject = checkAuth(req)
  if (authReject) return authReject

  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }
  try {
    body = await req.json() as typeof body
  } catch {
    return rpcErr(null, -32700, "Parse error: invalid JSON")
  }

  const { id, method, params } = body

  if (!method) return rpcErr(id ?? null, -32600, "Invalid Request: missing method")

  // initialize — agent identifies itself; we return server capabilities
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: SERVER_INFO,
      capabilities: CAPABILITIES,
    })
  }

  // notifications/initialized — fire-and-forget notification, no response needed
  if (method === "notifications/initialized") {
    return new Response(null, { status: 204 })
  }

  // tools/list — return the tool registry
  if (method === "tools/list") {
    return ok(id, {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    })
  }

  // tools/call — dispatch to the matching handler
  if (method === "tools/call") {
    const toolName = (params?.name as string | undefined)?.trim()
    const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>

    if (!toolName) return rpcErr(id, -32602, "Invalid params: missing tool name")

    const tool = TOOL_MAP.get(toolName)
    if (!tool) return rpcErr(id, -32602, `Unknown tool: ${toolName}`)

    try {
      const result = await tool.handler(toolArgs)
      return ok(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      })
    } catch (e) {
      console.error(`[mcp] tools/call ${toolName} error:`, e)
      return ok(id, {
        content: [{ type: "text", text: `{"error": "${(e as Error).message}"}` }],
        isError: true,
      })
    }
  }

  return rpcErr(id ?? null, -32601, `Method not found: ${method}`)
}
