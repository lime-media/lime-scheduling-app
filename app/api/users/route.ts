import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import type { Session } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcryptjs'

function isOps(session: Session | null) {
  return session?.user?.role === 'OPERATIONS'
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session || !isOps(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, created_at: true },
    orderBy: { created_at: 'asc' },
  })

  return NextResponse.json({ users })
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || !isOps(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { name, email, password, role } = await req.json()

  if (!name?.trim() || !email?.trim() || !password || !role) {
    return NextResponse.json({ error: 'All fields are required' }, { status: 400 })
  }
  if (!['SALES', 'OPERATIONS'].includes(role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
  }

  const existing = await prisma.user.findUnique({ where: { email: email.trim() } })
  if (existing) {
    return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
  }

  const password_hash = await bcrypt.hash(password, 12)
  const user = await prisma.user.create({
    data: { name: name.trim(), email: email.trim(), password_hash, role },
    select: { id: true, name: true, email: true, role: true, created_at: true },
  })

  return NextResponse.json({ user }, { status: 201 })
}
