// ─────────────────────────────────────────────────────────────────────────────
// secret-box — AES-256-GCM encryption for user-provided provider API keys.
// Shared by the Next.js API routes (encrypt/decrypt) and the translator
// mini-service (decrypt) so the SAME implementation guards the same data.
//
// Key derivation: SHA-256 of `${APP_SECRET}:${machineSecret}` where
// APP_SECRET comes from the environment and the machine secret lives at
// db/.provider-secret (auto-created, gitignored via db/, never committed).
// Ciphertext format: hex(iv):hex(authTag):hex(data) — authenticated.
// Plaintext keys are NEVER logged and NEVER returned to any client.
// ─────────────────────────────────────────────────────────────────────────────

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'

const SECRET_FILE = path.join(process.cwd(), 'db', '.provider-secret')

function appSecret(): string {
  return process.env.APP_SECRET ?? process.env.DATABASE_URL ?? 'voxshift-local-default'
}

function machineSecret(): string {
  try {
    if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, 'utf8').trim()
  } catch {
    /* fall through */
  }
  const secret = randomUUID() + randomUUID()
  try {
    mkdirSync(path.dirname(SECRET_FILE), { recursive: true })
    writeFileSync(SECRET_FILE, secret, { mode: 0o600 })
  } catch {
    /* read-only fs — derive from appSecret only */
  }
  return secret
}

let cachedKey: Buffer | null = null
function key(): Buffer {
  if (!cachedKey) {
    cachedKey = createHash('sha256').update(`${appSecret()}::${machineSecret()}`).digest()
  }
  return cachedKey
}

/** Encrypt a plaintext secret → "iv:tag:cipher" hex string. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

/** Decrypt "iv:tag:cipher" → plaintext (throws when tampered/mismatched key). */
export function decryptSecret(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(':')
  if (!ivHex || !tagHex || !dataHex) throw new Error('malformed secret payload')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()])
  return dec.toString('utf8')
}

/** UI-safe key hint: last 4 characters only. */
export function keyHint(plain: string): string {
  const trimmed = plain.trim()
  return trimmed.length >= 4 ? trimmed.slice(-4) : '••••'
}
