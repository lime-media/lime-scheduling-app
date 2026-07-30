/**
 * Mint a new MCP token for a given app user.
 *
 * Usage:
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/mint-mcp-token.ts <user_id> <label>
 *
 * Example:
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/mint-mcp-token.ts clxyz123 "OneScreen production"
 *
 * The raw token is printed ONCE to stdout. Only the bcrypt hash is stored.
 */

import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'

async function main() {
  const [, , userId, label] = process.argv

  if (!userId || !label) {
    console.error('Usage: mint-mcp-token.ts <user_id> <label>')
    console.error('Example: mint-mcp-token.ts clxyz123 "OneScreen production"')
    process.exit(1)
  }

  const prisma = new PrismaClient()

  try {
    // Verify user exists
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) {
      console.error(`Error: No user found with id "${userId}"`)
      console.error('\nAvailable users:')
      const users = await prisma.user.findMany({ select: { id: true, email: true, name: true } })
      for (const u of users) {
        console.error(`  ${u.id}  ${u.email}  (${u.name})`)
      }
      process.exit(1)
    }

    // Generate a secure random token
    const rawToken = `mcp_${crypto.randomBytes(32).toString('hex')}`
    const tokenHash = await bcrypt.hash(rawToken, 12)

    // Store the hash
    const record = await prisma.mcpToken.create({
      data: {
        token_hash: tokenHash,
        user_id: userId,
        label,
      },
    })

    console.log('\n--- MCP Token Created ---')
    console.log(`Token ID:  ${record.id}`)
    console.log(`User:      ${user.email} (${user.name})`)
    console.log(`Label:     ${label}`)
    console.log(`Created:   ${record.created_at.toISOString()}`)
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
