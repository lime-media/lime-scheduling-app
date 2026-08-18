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

  const users = await prisma.clientUser.findMany({
    select: { id: true, username: true, company_name: true, partner_id: true, created_at: true },
    orderBy: { created_at: 'asc' },
  })

  return NextResponse.json({ users })
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || !isOps(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { username, company_name, password, partner_id } = await req.json()

  if (!username?.trim() || !company_name?.trim() || !password) {
    return NextResponse.json({ error: 'Username, company name, and password are required' }, { status: 400 })
  }

  const existing = await prisma.clientUser.findUnique({ where: { username: username.trim() } })
  if (existing) {
    return NextResponse.json({ error: 'Username already in use' }, { status: 409 })
  }

  const password_hash = await bcrypt.hash(password, 12)
  const user = await prisma.clientUser.create({
    data: {
      username:     username.trim(),
      company_name: company_name.trim(),
      password_hash,
      // Optional — links this client to a RateAgreement for the AI quote engine (see
      // lib/pricing). Left null unless ops explicitly supplies it; standard rate card applies.
      partner_id:   partner_id?.trim() || null,
    },
    select: { id: true, username: true, company_name: true, partner_id: true, created_at: true },
  })

  return NextResponse.json({ user }, { status: 201 })
}
