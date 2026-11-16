import path from 'node:path'
import { readEnvFile } from './scripts/keeper-envfile.mjs'

// Secrets from Keeper. scripts/keeper-env.mjs (run before `next build` and
// `next dev`) writes them to .env.<KEEPER_ENV>. Vercel functions don't read
// .env files at runtime, so the values are compiled into the server and edge
// (middleware) bundles: every `process.env.NAME` in our code becomes the
// literal. They are never defined for the browser bundle.
const keeperEnv = (process.env.KEEPER_ENV || readEnvFile('.env').KEEPER_ENV || '').toLowerCase()
const keeperValues = keeperEnv ? readEnvFile(path.resolve(`.env.${keeperEnv}`)) : {}
if (process.env.VERCEL && Object.keys(keeperValues).length === 0) {
  throw new Error(`No Keeper secrets found in .env.${keeperEnv || '<KEEPER_ENV>'}; did scripts/keeper-env.mjs run?`)
}
// Also expose them to code that runs during the build itself (static rendering).
for (const [k, v] of Object.entries(keeperValues)) process.env[k] = v

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['mssql', 'tedious'],
  },
  webpack: (config, { isServer, webpack }) => {
    config.externals.push({
      'mssql':    'commonjs mssql',
      'tedious':  'commonjs tedious',
    })
    if (isServer && Object.keys(keeperValues).length > 0) {
      config.plugins.push(new webpack.DefinePlugin(
        Object.fromEntries(Object.entries(keeperValues).map(([k, v]) => [`process.env.${k}`, JSON.stringify(v)])),
      ))
    }
    return config
  },
}

export default nextConfig
