/**
 * GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&tool=…&actor=…
 *
 * The usage log (app_usage_log): every quote, hold booking and AI run in the
 * app and every MCP tool call, newest first, with counts by tool and by
 * person, and the MCP tokens with when each was last used. Operations only.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { toolLabel } from '@/lib/usageFormat'

const MAX_ROWS = 1000
const parse = (v: string | null) => { if (!v) return null; try { return JSON.parse(v) } catch { return v } }
const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v)

export type UsageRow = {
  id: string; at: string; source: 'app' | 'mcp'; tool: string; toolLabel: string
  actorType: string; actorId: string; actorName: string
  outcome: string; latencyMs: number; inputs: unknown; result: unknown
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (session.user?.role !== 'OPERATIONS') return NextResponse.json({ error: 'Only Operations users can see usage.' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const to = isDate(sp.get('to')) ? new Date(sp.get('to') + 'T23:59:59.999Z') : new Date()
  const from = isDate(sp.get('from')) ? new Date(sp.get('from') + 'T00:00:00Z') : new Date(to.getTime() - 7 * 86_400_000)
  const tool = sp.get('tool') || null
  const actor = sp.get('actor') || null
  // 'mcp' = every MCP tool; anything else is one tool's exact name.
  const toolWhere = !tool ? {} : tool === 'mcp' ? { tool: { startsWith: 'mcp_' } } : { tool }

  try {
    const [logRows, users, clients, tokens] = await Promise.all([
      prisma.usageLog.findMany({
        where: { created_at: { gte: from, lte: to }, ...toolWhere, ...(actor ? { actor_id: actor } : {}) },
        orderBy: { created_at: 'desc' }, take: MAX_ROWS,
      }),
      prisma.user.findMany({ select: { id: true, name: true } }),
      prisma.clientUser.findMany({ select: { id: true, company_name: true, username: true } }),
      prisma.mcpToken.findMany({ select: { id: true, label: true, user_id: true, user_type: true, created_at: true, revoked_at: true, last_used_at: true }, orderBy: { created_at: 'asc' } }),
    ])
    const names = new Map<string, string>([
      ...users.map(u => [u.id, u.name] as [string, string]),
      ...clients.map(c => [c.id, `${c.company_name} (${c.username})`] as [string, string]),
    ])

    const rows: UsageRow[] = logRows.map(r => ({
      id: r.id, at: r.created_at.toISOString(), source: r.tool.startsWith('mcp_') ? 'mcp' as const : 'app' as const,
      tool: r.tool, toolLabel: toolLabel(r.tool),
      actorType: r.actor_type, actorId: r.actor_id, actorName: names.get(r.actor_id) ?? r.actor_name,
      outcome: r.outcome, latencyMs: r.latency_ms, inputs: parse(r.inputs), result: parse(r.result),
    }))

    const count = (key: (r: UsageRow) => string) => {
      const m = new Map<string, number>()
      for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1)
      return [...m.entries()].map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count)
    }

    return NextResponse.json({
      from: from.toISOString(), to: to.toISOString(), truncated: logRows.length === MAX_ROWS,
      rows,
      byTool: count(r => r.toolLabel),
      byPerson: count(r => r.actorName),
      people: [...names.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      tokens: tokens.map(t => ({ ...t, owner: names.get(t.user_id) ?? t.user_id })),
    })
  } catch (err) {
    console.error('[usage] failed:', err)
    return NextResponse.json({ error: 'Usage could not be loaded. Has the usage-log migration been run?' }, { status: 500 })
  }
}
