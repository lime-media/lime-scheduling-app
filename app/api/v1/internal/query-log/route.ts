/**
 * POST /api/v1/internal/query-log — the MCP server reports each tool call here.
 * Recorded in the usage log (lib/usageLog.ts recordMcpUsage), the one record of
 * tool use; the Usage page shows it beside the app's own runs.
 */
import { NextRequest, NextResponse } from 'next/server'
import { validateInternalApiKey } from '@/lib/internalAuth'
import { recordMcpUsage } from '@/lib/usageLog'

export async function POST(req: NextRequest) {
  const keyError = validateInternalApiKey(req)
  if (keyError) return keyError

  const body = await req.json()
  const { user_id, user_type, tool_name, request_params, response_summary, outcome, latency_ms } = body

  if (!tool_name || !outcome || latency_ms === undefined) {
    return NextResponse.json(
      { error: 'Missing required fields: tool_name, outcome, latency_ms' },
      { status: 400 }
    )
  }

  const id = await recordMcpUsage({
    userId: user_id || null, userType: user_type || null, toolName: String(tool_name),
    requestParams: request_params, responseSummary: response_summary, outcome: String(outcome), latencyMs: Number(latency_ms),
  })
  if (!id) return NextResponse.json({ error: 'Not logged' }, { status: 500 })
  return NextResponse.json({ id }, { status: 201 })
}
