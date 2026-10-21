import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import type { Session } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcryptjs'
import { clientEmailRefusal } from '@/lib/clientEmail'

function isOps(session: Session | null) {
  return session?.user?.role === 'OPERATIONS'
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || !isOps(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { username, email, company_name, password, partner_id, sfdc_account_id } = await req.json()

  if (!username?.trim() || !company_name?.trim()) {
    return NextResponse.json({ error: 'Username and company name are required' }, { status: 400 })
  }
  // A client signs in with a code sent here; clearing it would leave the
  // account unable to log in at all (lib/clientOtp.ts).
  const emailRefusal = clientEmailRefusal(email)
  if (emailRefusal) {
    return NextResponse.json({ error: emailRefusal }, { status: 400 })
  }

  const conflict = await prisma.clientUser.findFirst({
    where: { username: username.trim(), NOT: { id: params.id } },
  })
  if (conflict) {
    return NextResponse.json({ error: 'Username already in use' }, { status: 409 })
  }

  const data: Record<string, string | null> = {
    username:        username.trim(),
    company_name:    company_name.trim(),
    email:           email.trim(),
    partner_id:      partner_id?.trim() || null,
    sfdc_account_id: sfdc_account_id?.trim() || null,
  }
  if (password) {
    data.password_hash = await bcrypt.hash(password, 12)
  }

  const user = await prisma.clientUser.update({
    where: { id: params.id },
    data,
    select: { id: true, username: true, email: true, company_name: true, partner_id: true, sfdc_account_id: true, created_at: true, last_active_at: true },
  })

  return NextResponse.json({ user })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || !isOps(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Login codes have no foreign key to this row (see prisma/schema.prisma
  // ClientOtpCode), so they are cleared here rather than by a cascade. Before
  // the user, so a failure can't leave a deleted account's codes behind.
  await prisma.clientOtpCode.deleteMany({ where: { client_user_id: params.id } })
  await prisma.clientUser.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
