#!/usr/bin/env node
// Redeem a Keeper Secrets Manager one-time access token and save the device
// config it produces to .keeper/<env>.json (gitignored).
//
//   KEEPER_ONE_TIME_TOKEN='US:...' node scripts/keeper-init.mjs uat
//
// A one-time token works exactly once. The durable credential is the base64
// device config written as KEEPER_KEY; that value (with KEEPER_ENV) is what
// goes into Vercel and into the local .env. See scripts/keeper-env.mjs.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { initializeStorage, inMemoryStorage, getSecrets } from '@keeper-security/secrets-manager-core'

const env = process.argv[2]
const token = process.env.KEEPER_ONE_TIME_TOKEN?.trim()
if (!env || !/^[a-z0-9-]+$/.test(env) || !token) {
  console.error("usage: KEEPER_ONE_TIME_TOKEN='US:...' node scripts/keeper-init.mjs <env>")
  process.exit(1)
}

const outDir = path.resolve('.keeper')
const outFile = path.join(outDir, `${env}.json`)
if (existsSync(outFile) && process.env.KEEPER_INIT_FORCE !== '1') {
  console.error(`${outFile} already exists; set KEEPER_INIT_FORCE=1 to overwrite it.`)
  process.exit(1)
}

const config = {}
const storage = inMemoryStorage(config)
await initializeStorage(storage, token)
// The first call binds the token to this device; after it the config is permanent.
const { records } = await getSecrets({ storage })

const key = Buffer.from(JSON.stringify(config)).toString('base64')
mkdirSync(outDir, { recursive: true })
writeFileSync(outFile, JSON.stringify({ KEEPER_ENV: env, KEEPER_KEY: key }, null, 2) + '\n', { mode: 0o600 })

console.log(`Saved ${outFile}. ${records.length} record(s) shared with this application:`)
for (const r of records) console.log(`  - ${r.data.title} [${r.data.type}]`)
