import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { getClientSession } from '@/lib/clientAuth'

export async function POST(req: NextRequest) {
  const session = getClientSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { currentPassword, newPassword } = await req.json()
    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: 'All fields required' }, { status: 400 })
    }
    if (newPassword.length < 8) {
      return NextResponse.json({ error: 'New password must be at least 8 characters' }, { status: 400 })
    }

    const user = await prisma.clientUser.findUnique({ where: { id: session.id } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const valid = await bcrypt.compare(currentPassword, user.password_hash)
    if (!valid) return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 })

    const hash = await bcrypt.hash(newPassword, 12)
    await prisma.clientUser.update({ where: { id: session.id }, data: { password_hash: hash } })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[client/auth/change-password]', e)
    return NextResponse.json({ error: 'Failed to change password' }, { status: 500 })
  }
}
