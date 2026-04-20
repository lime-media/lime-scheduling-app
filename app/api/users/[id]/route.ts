import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import type { Session } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcryptjs'

function isOps(session: Session | null) {
  return session?.user?.role === 'OPERATIONS'
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || !isOps(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { name, email, password, role } = await req.json()

  if (!name?.trim() || !email?.trim() || !role) {
    return NextResponse.json({ error: 'Name, email, and role are required' }, { status: 400 })
  }
  if (!['SALES', 'OPERATIONS'].includes(role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
  }

  // Cannot change your own role
  if (params.id === session.user.id && role !== session.user.role) {
    return NextResponse.json({ error: 'You cannot change your own role' }, { status: 400 })
  }

  // Check email uniqueness if changed
  const existing = await prisma.user.findUnique({ where: { email: email.trim() } })
  if (existing && existing.id !== params.id) {
    return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
  }

  const updateData: Record<string, unknown> = {
    name:  name.trim(),
    email: email.trim(),
    role,
  }
  if (password) {
    updateData.password_hash = await bcrypt.hash(password, 12)
  }

  const user = await prisma.user.update({
    where: { id: params.id },
    data:  updateData,
    select: { id: true, name: true, email: true, role: true, created_at: true },
  })

  return NextResponse.json({ user })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || !isOps(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (params.id === session.user.id) {
    return NextResponse.json({ error: 'You cannot delete your own account' }, { status: 400 })
  }

  // Guard: cannot delete the last OPERATIONS user
  const target = await prisma.user.findUnique({ where: { id: params.id } })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  if (target.role === 'OPERATIONS') {
    const opsCount = await prisma.user.count({ where: { role: 'OPERATIONS' } })
    if (opsCount <= 1) {
      return NextResponse.json(
        { error: 'Cannot delete the last Operations admin' },
        { status: 400 }
      )
    }
  }

  await prisma.user.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
