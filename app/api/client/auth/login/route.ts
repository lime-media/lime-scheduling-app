import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { setClientSession } from '@/lib/clientAuth'

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json()
    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 })
    }

    const user = await prisma.clientUser.findUnique({ where: { username } })
    if (!user) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    // A login is activity (Users page "Last activity"). Never fails the login.
    await prisma.clientUser.update({ where: { id: user.id }, data: { last_active_at: new Date() } })
      .catch(err => console.error('[client login] last activity not recorded:', err instanceof Error ? err.message : err))
    const res = NextResponse.json({
      id:          user.id,
      username:    user.username,
      companyName: user.company_name,
    })
    setClientSession(res, {
      id:             user.id,
      username:       user.username,
      companyName:    user.company_name,
      partnerId:      user.partner_id ?? undefined,
      sfdcAccountId:  user.sfdc_account_id ?? undefined,
    })
    return res
  } catch (e) {
    console.error('[client/auth/login]', e)
    return NextResponse.json({ error: 'Login failed' }, { status: 500 })
  }
}
