import { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { getPool } from './mssql'

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
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        console.log('[auth] authorize called, email:', credentials?.email)
        if (!credentials?.email || !credentials?.password) {
          return null
        }
        try {
          const pool = await getPool()
          console.log('[auth] pool connected')
          const result = await pool
            .request()
            .input('email', credentials.email)
            .query('SELECT id, email, name, password_hash, role FROM dbo.app_users WHERE email = @email')
          console.log('[auth] query result count:', result.recordset.length)
          const user = result.recordset[0]
          if (!user) {
            console.log('[auth] user not found')
            return null
          }
          const isValid = await bcrypt.compare(credentials.password, user.password_hash)
          console.log('[auth] password valid:', isValid)
          if (!isValid) return null
          return { id: user.id, email: user.email, name: user.name, role: user.role }
        } catch (e) {
          console.error('[auth] error:', (e as Error).message)
          return null
        }
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
