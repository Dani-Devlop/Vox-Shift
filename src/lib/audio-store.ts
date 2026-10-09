import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import path from 'path'

// ─────────────────────────────────────────────────────────────────────────────
// Audio store — disk cache for persisted TTS audio of history entries.
// Files live at db/audio/{historyEntryId}.wav. The path is derived from the
// entry id (no schema column needed); GET /api/history checks existence so
// `hasAudio` always reflects what is actually replayable.
// A rolling cap keeps disk usage bounded.
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIO_DIR = path.join(process.cwd(), 'db', 'audio')

/** Keep at most this many cached utterance WAVs (newest win). */
export const MAX_AUDIO_FILES = 40

/** Base64 WAV payloads beyond ~2.6 MB are skipped (short utterances are ~0.2–0.7 MB). */
export const MAX_AUDIO_B64_LEN = 3_500_000

export function audioFilePath(id: string): string {
  return path.join(AUDIO_DIR, `${id}.wav`)
}

export function ensureAudioDir(): void {
  mkdirSync(AUDIO_DIR, { recursive: true })
}

export function audioFileExists(id: string): boolean {
  return existsSync(audioFilePath(id))
}

/** cuid-ish ids only — blocks path traversal via the dynamic route. */
export function isValidHistoryId(id: string): boolean {
  return /^[a-z0-9]+$/i.test(id)
}

/** Delete the oldest cached WAVs beyond the rolling cap. */
export function pruneAudioFiles(keep: number = MAX_AUDIO_FILES): void {
  try {
    if (!existsSync(AUDIO_DIR)) return
    const files = readdirSync(AUDIO_DIR)
      .filter((f) => f.endsWith('.wav'))
      .map((f) => {
        const full = path.join(AUDIO_DIR, f)
        try {
          return { full, mtime: statSync(full).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((v): v is { full: string; mtime: number } => v !== null)
      .sort((a, b) => b.mtime - a.mtime)
    for (const old of files.slice(keep)) {
      try {
        unlinkSync(old.full)
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort cleanup — never break the request path
  }
}

/** Remove every cached WAV (used by DELETE /api/history). */
export function clearAudioFiles(): void {
  try {
    if (!existsSync(AUDIO_DIR)) return
    for (const f of readdirSync(AUDIO_DIR)) {
      if (!f.endsWith('.wav')) continue
      try {
        unlinkSync(path.join(AUDIO_DIR, f))
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}

/** Remove ONE cached WAV (single-entry delete). Best-effort, idempotent. */
export function deleteAudioFile(id: string): void {
  try {
    if (!isValidHistoryId(id)) return
    const p = audioFilePath(id)
    if (existsSync(p)) unlinkSync(p)
  } catch {
    // best-effort
  }
}
