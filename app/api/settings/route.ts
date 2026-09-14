import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import {
  getAllSettings,
  setSetting,
  validateEmailList,
  SETTING_SPECS,
  type SettingKey,
} from '@/lib/appSettings'

/** Editing settings is an OPERATIONS action, same gate as user management. */
function canEdit(session: { user?: { role?: string } } | null): boolean {
  return session?.user?.role === 'OPERATIONS'
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Readable by any signed-in user — knowing where alerts go is useful even if
  // you cannot change it — but the UI is read-only unless you can edit.
  return NextResponse.json({
    settings: await getAllSettings(),
    canEdit: canEdit(session),
  })
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canEdit(session)) {
    return NextResponse.json({ error: 'Only OPERATIONS users can change settings' }, { status: 403 })
  }

  let body: { key?: string; value?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { key, value } = body
  if (!key || typeof value !== 'string') {
    return NextResponse.json({ error: 'key and value are required' }, { status: 400 })
  }
  if (!SETTING_SPECS.some(s => s.key === key)) {
    return NextResponse.json({ error: `Unknown setting: ${key}` }, { status: 400 })
  }

  // Every setting is currently a recipient list. Validated server-side so a bad
  // address cannot be saved and silently break a notification later.
  const invalid = validateEmailList(value)
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })

  try {
    await setSetting(key as SettingKey, value.trim(), session.user?.email ?? 'unknown')
  } catch (err) {
    console.error('[settings] save failed:', err)
    return NextResponse.json({ error: 'Failed to save setting' }, { status: 500 })
  }

  return NextResponse.json({ settings: await getAllSettings(), canEdit: true })
}
