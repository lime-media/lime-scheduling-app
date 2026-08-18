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

  const { username, company_name, password, partner_id } = await req.json()

  if (!username?.trim() || !company_name?.trim()) {
    return NextResponse.json({ error: 'Username and company name are required' }, { status: 400 })
  }

  const conflict = await prisma.clientUser.findFirst({
    where: { username: username.trim(), NOT: { id: params.id } },
  })
  if (conflict) {
    return NextResponse.json({ error: 'Username already in use' }, { status: 409 })
  }

  const data: Record<string, string | null> = {
    username:     username.trim(),
    company_name: company_name.trim(),
    // Optional — links this client to a RateAgreement for the AI quote engine (see lib/pricing).
    // An empty string clears it back to standard rate-card pricing.
    partner_id:   partner_id?.trim() || null,
  }
  if (password) {
    data.password_hash = await bcrypt.hash(password, 12)
  }

  const user = await prisma.clientUser.update({
    where: { id: params.id },
    data,
    select: { id: true, username: true, company_name: true, partner_id: true, created_at: true },
  })

  return NextResponse.json({ user })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || !isOps(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  await prisma.clientUser.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
