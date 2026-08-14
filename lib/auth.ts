import { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { getPool } from './mssql'
import { verifyLoginOtp } from './otp'

export interface InternalUser {
  id:    string
  email: string
  name:  string
  role:  string
}

/**
 * Password check against dbo.app_users — shared by authorize() (step 2 of
 * login, below) and /api/auth/request-otp (step 1, which sends the code).
 * Kept as raw SQL via lib/mssql.ts to match how this lookup has always been
 * done here, rather than switching it to the Prisma client mid-flow.
 */
export async function verifyInternalCredentials(email: string, password: string): Promise<InternalUser | null> {
  try {
    const pool = await getPool()
    const result = await pool
      .request()
      .input('email', email)
      .query('SELECT id, email, name, password_hash, role FROM dbo.app_users WHERE email = @email')
    const user = result.recordset[0]
    if (!user) return null
    const isValid = await bcrypt.compare(password, user.password_hash)
    if (!isValid) return null
    return { id: user.id, email: user.email, name: user.name, role: user.role }
  } catch (e) {
    const err = e as Error & { code?: string; number?: number }
    console.error('[auth] verifyInternalCredentials error:', err.message, '| code:', err.code, '| number:', err.number)
    return null
  }
}

export const authOptions: NextAuthOptions = {
  session: {
    strategy: 'jwt',
  },
  pages: {
    signIn: '/login',
  },
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email:    { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        otp:      { label: 'Code', type: 'text' },
      },
      // Step 2 of login — called only after /api/auth/request-otp has
      // already verified the password once and emailed a code. Re-verifies
      // the password here too (this call is what actually issues a
      // session, so it can't rely on step 1 having happened) and then
      // consumes the OTP. Thrown errors surface verbatim as result.error
      // from next-auth/react's signIn(), which the login page displays
      // directly — that's how the specific "expired" / "N attempts left"
      // messages reach the user instead of a generic failure.
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password || !credentials?.otp) {
          return null
        }
        const user = await verifyInternalCredentials(credentials.email, credentials.password)
        if (!user) {
          throw new Error('Invalid email or password')
        }
        await verifyLoginOtp(user.id, credentials.otp) // throws with a user-facing message on failure
        return user
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.role = (user as unknown as { role: string }).role
      }
      return token
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string
        session.user.role = token.role as string
      }
      return session
    },
  },
}
