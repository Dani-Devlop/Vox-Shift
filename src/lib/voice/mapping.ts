// ─────────────────────────────────────────────────────────────────────────────
// Voice identity mapping — matches analyzed acoustic features to the closest
// engine voice. This is the MVP "voice identity" strategy:
//   user's acoustic features → engine voice + speed adjustment
// Modular by design: swapping the Voice Engine = swapping this table only.
// ─────────────────────────────────────────────────────────────────────────────

import type { VoiceFeatures } from './analysis'

export interface VoiceMapping {
  mappedVoice: string
  speedAdjust: number
  /** Output pitch-shift factor: user's mean F0 ÷ the engine voice's center F0.
   *  Applied by the synthesis stage (speed-compensated resampling) so the
   *  generated audio follows the user's register. Clamped 0.75..1.33. */
  pitchRatio: number
  estimatedGender: 'male' | 'female' | 'neutral'
  voiceCharacter: string // e.g. "Warm · Bright"
}

type VoiceSlot = {
  voice: string
  f0Center: number // representative pitch of the engine voice
  label: string
}

/**
 * Engine voice slots ordered by representative F0 (Hz).
 * These centers were chosen from the engine's published voice characters:
 *   jam (deep British male) < xiaochen (calm male) < kazi (clear neutral)
 *   < douji (natural) < tongtong (warm female) < chuichui (bright lively female)
 * < luodo (expressive) is an alternate for the mid-high band.
 */
const VOICE_SLOTS: VoiceSlot[] = [
  { voice: 'jam', f0Center: 95, label: 'Deep & Calm' },
  { voice: 'xiaochen', f0Center: 125, label: 'Steady & Professional' },
  { voice: 'kazi', f0Center: 155, label: 'Clear & Neutral' },
  { voice: 'douji', f0Center: 185, label: 'Natural & Smooth' },
  { voice: 'tongtong', f0Center: 210, label: 'Warm & Friendly' },
  { voice: 'chuichui', f0Center: 250, label: 'Bright & Lively' },
]

function pitchLabel(meanF0: number): string {
  if (meanF0 < 105) return 'Deep'
  if (meanF0 < 145) return 'Low'
  if (meanF0 < 190) return 'Medium'
  if (meanF0 < 240) return 'High'
  return 'Very High'
}

function brightnessLabel(centroid: number): string {
  if (centroid < 1900) return 'Soft'
  if (centroid < 2800) return 'Balanced'
  return 'Bright'
}

function tempoLabel(rate: number): string | null {
  if (rate <= 0) return null
  if (rate < 3.5) return 'Unhurried'
  if (rate < 5.5) return 'Measured'
  return 'Quick'
}

export function mapVoiceToEngine(features: VoiceFeatures): VoiceMapping {
  const meanF0 = features.meanF0

  // Degenerate sample (mostly silence): fall back to neutral voice.
  if (!meanF0 || meanF0 <= 0) {
    return {
      mappedVoice: 'kazi',
      speedAdjust: 1.0,
      pitchRatio: 1.0,
      estimatedGender: 'neutral',
      voiceCharacter: 'Neutral · Balanced',
    }
  }

  // Nearest slot by F0 distance
  let best = VOICE_SLOTS[0]
  let bestDist = Math.abs(Math.log(meanF0 / best.f0Center))
  for (const slot of VOICE_SLOTS.slice(1)) {
    const dist = Math.abs(Math.log(meanF0 / slot.f0Center))
    if (dist < bestDist) {
      bestDist = dist
      best = slot
    }
  }

  // Brightness refinement: very bright samples shift one slot up (toward
  // brighter voices), very dark samples shift one slot down.
  const centroid = features.spectralCentroid
  if (centroid > 3200) {
    const idx = VOICE_SLOTS.indexOf(best)
    if (idx < VOICE_SLOTS.length - 1) best = VOICE_SLOTS[idx + 1]
  } else if (centroid > 0 && centroid < 1600) {
    const idx = VOICE_SLOTS.indexOf(best)
    if (idx > 0) best = VOICE_SLOTS[idx - 1]
  }

  const estimatedGender: VoiceMapping['estimatedGender'] =
    meanF0 < 145 ? 'male' : meanF0 > 175 ? 'female' : 'neutral'

  // Speed: match the user's tempo (typical conversational rate ≈ 5 syl/s).
  const rate = features.speakingRate
  let speedAdjust = 1.0
  if (rate > 0) {
    speedAdjust = Math.min(1.15, Math.max(0.85, rate / 5))
  }

  const parts = [pitchLabel(meanF0), brightnessLabel(centroid)]
  const character = parts.join(' · ')

  // Pitch conformance: shift the engine voice's register toward the user's
  // measured F0. The slot center is the engine voice's representative pitch;
  // the ratio drives the synthesis-stage pitch shift (clamped for quality —
  // see voice.ts). Round to 3 decimals to keep payloads tidy.
  const pitchRatio = Math.round(Math.min(1.33, Math.max(0.75, meanF0 / best.f0Center)) * 1000) / 1000

  return {
    mappedVoice: best.voice,
    speedAdjust: Math.round(speedAdjust * 100) / 100,
    pitchRatio,
    estimatedGender,
    voiceCharacter: character,
  }
}

export function describeProfile(features: VoiceFeatures, mapping: VoiceMapping): string {
  const tempo = tempoLabel(features.speakingRate)
  const bits = [mapping.voiceCharacter]
  if (tempo) bits.push(tempo)
  return bits.join(' · ')
}
