/**
 * Engine-level probe: proves the VoiceIdentityEngine NEVER silently falls
 * back to a preset voice for clone-mode requests. Run: bun engines/probe-clone-router.ts
 */
import { VoiceIdentityEngine } from './voice'

async function expectError(label: string, promise: Promise<unknown>, mustContain: string) {
  try {
    await promise
    console.log(`✗ ${label}: NO ERROR THROWN — fallback happened (BAD)`)
    process.exitCode = 1
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const ok = msg.toLowerCase().includes(mustContain.toLowerCase())
    console.log(`${ok ? '✓' : '✗'} ${label}: "${msg.slice(0, 140)}"`)
    if (!ok) process.exitCode = 1
  }
}

async function main() {
  const engine = new VoiceIdentityEngine()

  await expectError(
    'clone mode + key missing',
    engine.synthesize('Hello world', { voice: 'kazi', speed: 1, profileMode: 'clone', providerProfileId: 'fake-voice-id' }),
    'not configured'
  )

  await expectError(
    'clone mode + no provider voice id',
    engine.synthesize('Hello world', { voice: 'kazi', speed: 1, profileMode: 'clone' }),
    'no provider voice id'
  )

  console.log('Router probe finished.')
}

void main()
