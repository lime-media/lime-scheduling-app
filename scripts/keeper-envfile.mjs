// Read and write the simple KEY="value" files the Keeper loader uses.
// Values are written double-quoted with \\, ", newline and $ escaped, and read
// back without variable expansion, so a secret containing "$" or "=" survives
// the round trip. (Next's own .env loader expands $VARS; the env-specific file
// is not one it loads, see next.config.mjs.)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const quote = (v) =>
  '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\$/g, '\\$') + '"'

const unquote = (raw) => {
  const v = raw.trim()
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c))
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1)
  return v.replace(/\s+#.*$/, '')
}

export function readEnvFile(file) {
  const out = {}
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (m) out[m[1]] = unquote(m[2])
  }
  return out
}

export function writeEnvFile(file, values, header = []) {
  const lines = [...header.map((h) => `# ${h}`), ...Object.entries(values).map(([k, v]) => `${k}=${quote(v)}`)]
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
}

// Set or replace some keys in an existing env file, leaving every other line as it was.
export function upsertEnvFile(file, values) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []
  const pending = new Map(Object.entries(values))
  const updated = lines.map((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (m && pending.has(m[1])) {
      const v = pending.get(m[1])
      pending.delete(m[1])
      return `${m[1]}=${quote(v)}`
    }
    return line
  })
  while (updated.length && updated[updated.length - 1] === '') updated.pop()
  for (const [k, v] of pending) updated.push(`${k}=${quote(v)}`)
  writeFileSync(file, updated.join('\n') + '\n', { mode: 0o600 })
}
