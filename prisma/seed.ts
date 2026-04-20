import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  const password = await bcrypt.hash('LimeMedia2024!', 12)

  const admin = await prisma.user.upsert({
    where: { email: 'admin@limemedia.com' },
    update: {},
    create: {
      email: 'admin@limemedia.com',
      name: 'Admin User',
      password_hash: password,
      role: 'OPERATIONS',
    },
  })

  const sarah = await prisma.user.upsert({
    where: { email: 'schaudhari@lime-media.com' },
    update: {},
    create: {
      email: 'schaudhari@lime-media.com',
      name: 'Sarah Chaudhari',
      password_hash: password,
      role: 'OPERATIONS',
    },
  })

  const sales = await prisma.user.upsert({
    where: { email: 'sales@limemedia.com' },
    update: {},
    create: {
      email: 'sales@limemedia.com',
      name: 'Sales User',
      password_hash: password,
      role: 'SALES',
    },
  })

  console.log('Seeded users:', { admin: admin.email, sarah: sarah.email, sales: sales.email })
  console.log('Default password: LimeMedia2024!')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
