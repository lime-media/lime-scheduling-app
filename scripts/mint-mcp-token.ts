/**
 * Mint a new MCP token for an app user or client user.
 *
 * Usage:
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/mint-mcp-token.ts <user_type> <user_id> <label>
 *
 * Examples:
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/mint-mcp-token.ts app_user clxyz123 "Internal dev"
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/mint-mcp-token.ts client_user clxyz456 "OneScreen production"
 *
 * The raw token is printed ONCE to stdout. Only the bcrypt hash is stored.
 */

import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'

const VALID_USER_TYPES = ['app_user', 'client_user'] as const
type UserType = typeof VALID_USER_TYPES[number]

async function main() {
  const [, , userType, userId, label] = process.argv

  if (!userType || !userId || !label) {
    console.error('Usage: mint-mcp-token.ts <user_type> <user_id> <label>')
    console.error('  user_type: app_user | client_user')
    console.error('')
    console.error('Examples:')
    console.error('  mint-mcp-token.ts app_user clxyz123 "Internal dev"')
    console.error('  mint-mcp-token.ts client_user clxyz456 "OneScreen production"')
    process.exit(1)
  }

  if (!VALID_USER_TYPES.includes(userType as UserType)) {
    console.error(`Error: user_type must be "app_user" or "client_user", got "${userType}"`)
    process.exit(1)
  }

  const prisma = new PrismaClient()

  try {
    // Verify user exists in the appropriate table
    let userDisplay: string

    if (userType === 'app_user') {
      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user) {
        console.error(`Error: No app_user found with id "${userId}"`)
        console.error('\nAvailable app_users:')
        const users = await prisma.user.findMany({ select: { id: true, email: true, name: true } })
        for (const u of users) {
          console.error(`  ${u.id}  ${u.email}  (${u.name})`)
        }
        process.exit(1)
      }
      userDisplay = `${user.email} (${user.name})`
    } else {
      const clientUser = await prisma.clientUser.findUnique({ where: { id: userId } })
      if (!clientUser) {
        console.error(`Error: No client_user found with id "${userId}"`)
        console.error('\nAvailable client_users:')
        const users = await prisma.clientUser.findMany({ select: { id: true, username: true, company_name: true } })
        for (const u of users) {
          console.error(`  ${u.id}  ${u.username}  (${u.company_name})`)
        }
        process.exit(1)
      }
      userDisplay = `${clientUser.username} (${clientUser.company_name})`
    }

    // Generate a secure random token
    const rawToken = `mcp_${crypto.randomBytes(32).toString('hex')}`
    const tokenHash = await bcrypt.hash(rawToken, 12)

    // Store the hash
    const record = await prisma.mcpToken.create({
      data: {
        token_hash: tokenHash,
        user_id: userId,
        user_type: userType,
        label,
      },
    })

    console.log('\n--- MCP Token Created ---')
    console.log(`Token ID:   ${record.id}`)
    console.log(`User Type:  ${userType}`)
    console.log(`User:       ${userDisplay}`)
    console.log(`Label:      ${label}`)
    console.log(`Created:    ${record.created_at.toISOString()}`)
    console.log('')
    console.log(`Raw Token (copy now — will NOT be shown again):`)
    console.log('')
    console.log(`  ${rawToken}`)
    console.log('')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
