import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'OPERATIONS') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const existing = await prisma.rateAgreement.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const { sfdc_account_id, name, agreement_type, effective_date, expiration_date, rate_overrides, notes } = body

  if (rate_overrides) {
    try {
      if (typeof rate_overrides === 'string') JSON.parse(rate_overrides)
    } catch {
      return NextResponse.json({ error: 'rate_overrides must be valid JSON' }, { status: 400 })
    }
  }

  const updated = await prisma.rateAgreement.update({
    where: { id: params.id },
    data: {
      ...(sfdc_account_id && { sfdc_account_id, partner_id: sfdc_account_id }),
      ...(name && { name }),
      ...(agreement_type && { agreement_type }),
      ...(effective_date && { effective_date: new Date(effective_date) }),
      ...(expiration_date && { expiration_date: new Date(expiration_date) }),
      ...(rate_overrides && { rate_overrides: typeof rate_overrides === 'string' ? rate_overrides : JSON.stringify(rate_overrides) }),
      ...(notes !== undefined && { notes: notes || null }),
    },
  })

  return NextResponse.json(updated)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'OPERATIONS') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const existing = await prisma.rateAgreement.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await prisma.rateAgreement.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
