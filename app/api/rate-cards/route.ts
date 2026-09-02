import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const agreements = await prisma.rateAgreement.findMany({
    orderBy: { created_at: 'desc' },
  })

  return NextResponse.json({
    agreements: agreements.map((a) => ({
      id:               a.id,
      partner_id:       a.partner_id,
      sfdc_account_id:  a.sfdc_account_id,
      name:             a.name,
      agreement_type:   a.agreement_type,
      effective_date:   a.effective_date.toISOString().split('T')[0],
      expiration_date:  a.expiration_date.toISOString().split('T')[0],
      rate_overrides:   a.rate_overrides,
      notes:            a.notes,
      created_by:       a.created_by,
      created_at:       a.created_at.toISOString(),
    })),
  })
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'OPERATIONS') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { sfdc_account_id, name, agreement_type, effective_date, expiration_date, rate_overrides, notes } = body

  if (!sfdc_account_id || !name || !effective_date || !expiration_date || !rate_overrides) {
    return NextResponse.json({ error: 'Salesforce Account, name, and dates are required' }, { status: 400 })
  }

  try {
    if (typeof rate_overrides === 'string') JSON.parse(rate_overrides)
  } catch {
    return NextResponse.json({ error: 'rate_overrides must be valid JSON' }, { status: 400 })
  }

  const agreement = await prisma.rateAgreement.create({
    data: {
      partner_id: sfdc_account_id, // Use sfdc_account_id as partner_id for backward compat
      sfdc_account_id,
      name,
      agreement_type: agreement_type || 'custom',
      effective_date: new Date(effective_date),
      expiration_date: new Date(expiration_date),
      rate_overrides: typeof rate_overrides === 'string' ? rate_overrides : JSON.stringify(rate_overrides),
      created_by: session.user.id,
      notes: notes || null,
    },
  })

  return NextResponse.json(agreement, { status: 201 })
}
