import {
  CLUSTER_MERGE_THRESHOLD,
  HYSTERESIS_THRESHOLD,
  cosineSimilarity,
  type MatchCandidate,
  matchVoiceprint,
} from '../../../src/lib/speaker/voiceprint'

// ─────────────────────────────────────────────────────────────────────────────
// SpeakerTracker — real-time speaker recognition & persistent tracking
// (master prompt v2 §4/§12/§13/§15/§16).
//
// Per live session (one per socket):
//   · Enrolled Voice Contacts (synced from the client) are matched FIRST.
//   · Voices that match no contact become UNKNOWN speakers with STABLE
//     temporary ids (spk_001, spk_002…) that persist for the whole
//     conversation — never randomly renamed (spec §5).
//   · Hysteresis + short-utterance context rules prevent flicker and prevent
//     "بله/نه" creating phantom speakers.
//   · Unknown is better than wrong: weak evidence NEVER gets a name.
//
// The tracker also keeps (bounded) clean speech segments per unknown cluster
// so the ~10 s enrollment sample can be assembled on demand (spec §6).
// ─────────────────────────────────────────────────────────────────────────────

export interface TrackedContact {
  contactId: string
  name: string
  vector: number[]
  threshold?: number
  disabled?: boolean
}

export interface SpeakerCandidate {
  contactId: string
  name: string
  score: number
}

export type IdentificationStatus = 'verified' | 'possible' | 'unknown' | 'context'

/** Speaker block attached to pipeline results (spec §21 structured data). */
export interface SpeakerInfo {
  /** Stable temporary id, e.g. 'spk_001' — survives the whole conversation. */
  clusterKey: string
  contactId?: string
  /** Display name: contact name, user correction, or "Unknown N". */
  name?: string
  status: IdentificationStatus
  /** Measured cosine similarity 0..1 when a real comparison happened. */
  confidence?: number
  /** Present when two contacts are too close to call (spec §14). */
  candidates?: SpeakerCandidate[]
}

interface ClusterSegment {
  pcm: Buffer
  sampleRate: number
  speechSec: number
  at: number
}

interface Cluster {
  key: string
  contactId: string | null
  /** Manually assigned label (user correction) — wins over "Unknown N". */
  label: string | null
  /** Running centroid of voiceprints assigned to this cluster. */
  vector: number[] | null
  count: number
  lastSeenAt: number
  /** Bounded clean-speech segments kept for enrollment sampling. */
  segments: ClusterSegment[]
  totalSpeechSec: number
}

/** Keep at most this much speech per unknown cluster for enrollment (~10 s
 *  target + headroom). Segments beyond the cap are dropped — disclosed. */
const MAX_CLUSTER_SPEECH_SEC = 24
const MAX_SEGMENTS_PER_CLUSTER = 6
/** Utterances shorter than this rely on context instead of new speakers. */
const SHORT_UTTERANCE_SEC = 1.0
/** Min similarity to attribute a short utterance to the previous speaker. */
const SHORT_KEEP_THRESHOLD = 0.8

export class SpeakerTracker {
  private contacts: TrackedContact[] = []
  private clusters = new Map<string, Cluster>()
  private order: string[] = [] // insertion order → stable numbering
  private counter = 0
  private previousKey: string | null = null

  /** Replace the enrolled contact set (client `contacts:sync`). */
  setContacts(contacts: TrackedContact[]): void {
    this.contacts = contacts.filter(
      (c) => c && typeof c.contactId === 'string' && Array.isArray(c.vector) && c.vector.length > 0 && !c.disabled
    )
    // A labeled cluster keeps its identity even if the contact list changed.
    for (const c of this.contacts) {
      for (const cluster of this.clusters.values()) {
        if (cluster.contactId === c.contactId && cluster.label !== c.name) {
          cluster.label = c.name
        }
      }
    }
  }

  getContactsSnapshot(): TrackedContact[] {
    return this.contacts.map((c) => ({ ...c }))
  }

  /** Start a NEW conversation: clear clusters + previous-speaker state. */
  reset(): void {
    this.clusters.clear()
    this.order = []
    this.counter = 0
    this.previousKey = null
  }

  /** Seed from a persisted conversation registry (thread reopen). */
  seed(
    clusters: Array<{ clusterKey: string; contactId?: string | null; name?: string | null; vector?: number[] | null }>
  ): void {
    for (const c of clusters) {
      if (!c?.clusterKey || this.clusters.has(c.clusterKey)) continue
      this.clusters.set(c.clusterKey, {
        key: c.clusterKey,
        contactId: c.contactId ?? null,
        label: c.name ?? null,
        vector: c.vector ?? null,
        count: 1,
        lastSeenAt: Date.now(),
        segments: [],
        totalSpeechSec: 0,
      })
      this.order.push(c.clusterKey)
      const num = Number(c.clusterKey.replace('spk_', ''))
      if (Number.isFinite(num) && num > this.counter) this.counter = num
    }
  }

  /** Current registry snapshot (client persists it per conversation). */
  snapshot(): Array<{ clusterKey: string; contactId: string | null; name: string | null; vector: number[] | null }> {
    return this.order
      .map((key) => this.clusters.get(key))
      .filter((c): c is Cluster => Boolean(c))
      .map((c) => ({ clusterKey: c.key, contactId: c.contactId, name: this.displayNameOf(c), vector: c.vector }))
  }

  /**
   * Assign an incoming utterance to a speaker.
   * `voiceprint` is null when the audio had too little usable speech —
   * the utterance then rides on context (previous speaker), never a guess.
   */
  assign(
    voiceprint: { vector: number[]; speechSec: number } | null,
    audio?: { pcm: Buffer; sampleRate: number; speechSec: number }
  ): SpeakerInfo | null {
    const now = Date.now()

    // No usable voiceprint → context-only attribution.
    if (!voiceprint) {
      const prev = this.previousKey ? this.clusters.get(this.previousKey) : null
      if (!prev) return null
      return {
        clusterKey: prev.key,
        contactId: prev.contactId ?? undefined,
        name: this.displayNameOf(prev),
        status: 'context',
      }
    }

    const query = voiceprint.vector
    const shortUtterance = voiceprint.speechSec < SHORT_UTTERANCE_SEC
    const prev = this.previousKey ? this.clusters.get(this.previousKey) : null
    const simTo = (c: Cluster | null | undefined) =>
      c && c.vector ? cosineSimilarity(query, c.vector) : 0

    // ── 1. Short utterances (spec §15): never spawn a new speaker. ──────────
    if (shortUtterance && prev) {
      const sim = simTo(prev)
      if (sim >= SHORT_KEEP_THRESHOLD) {
        this.attachSegment(prev, audio, now)
        return {
          clusterKey: prev.key,
          contactId: prev.contactId ?? undefined,
          name: this.displayNameOf(prev),
          status: 'context',
          confidence: this.round(sim),
        }
      }
      // Weak match — still no new speaker, but honestly unverified context.
      return {
        clusterKey: prev.key,
        contactId: prev.contactId ?? undefined,
        name: this.displayNameOf(prev),
        status: 'context',
      }
    }

    // ── 2. Hysteresis (spec §16): a stable match to the previous speaker wins
    //      before contact matching — one noisy frame must not flip speakers.
    if (prev && !prev.contactId) {
      const sim = simTo(prev)
      if (sim >= HYSTERESIS_THRESHOLD) {
        this.updateCentroid(prev, query)
        this.attachSegment(prev, audio, now)
        this.previousKey = prev.key
        return {
          clusterKey: prev.key,
          name: this.displayNameOf(prev),
          status: 'unknown',
          confidence: this.round(sim),
        }
      }
    }
    if (prev?.contactId) {
      const sim = simTo(prev)
      if (sim >= HYSTERESIS_THRESHOLD) {
        // Confirm it is still the best contact — hysteresis never overrides a
        // clearly better contact match.
        const match = matchVoiceprint(
          query,
          this.contacts.map((c) => ({ id: c.contactId, name: c.name, vector: c.vector, threshold: c.threshold }))
        )
        const prevIsBest = match.best?.id === prev.contactId && match.verdict !== 'none'
        if (prevIsBest || sim >= 0.95) {
          this.updateCentroid(prev, query)
          this.attachSegment(prev, audio, now)
          this.previousKey = prev.key
          return {
            clusterKey: prev.key,
            contactId: prev.contactId,
            name: this.displayNameOf(prev),
            status: 'verified',
            confidence: this.round(sim),
          }
        }
      }
    }

    // ── 3. Contact matching (spec §13): verified / ambiguous / none. ────────
    const match = matchVoiceprint(
      query,
      this.contacts.map((c) => ({ id: c.contactId, name: c.name, vector: c.vector, threshold: c.threshold }))
    )

    if (match.verdict === 'verified' && match.best) {
      const contact = this.contacts.find((c) => c.contactId === match.best!.id)
      let cluster = this.findClusterByContact(contact!.contactId)
      if (!cluster) cluster = this.createCluster(now, contact!.contactId, contact!.name)
      cluster.vector = contact!.vector
      cluster.contactId = contact!.contactId
      cluster.label = contact!.name
      this.attachSegment(cluster, audio, now)
      this.previousKey = cluster.key
      return {
        clusterKey: cluster.key,
        contactId: contact!.contactId,
        name: contact!.name,
        status: 'verified',
        confidence: this.round(match.best.score),
      }
    }

    if (match.verdict === 'ambiguous' && match.best) {
      // Spec §14: never silently choose. Candidates ride the result; the
      // speaker stays an Unknown cluster until the user confirms.
      const candidates: SpeakerCandidate[] = [
        { contactId: match.best.id, name: match.best.name, score: this.score3(match.best.score) },
        ...(match.second
          ? [{ contactId: match.second.id, name: match.second.name, score: this.score3(match.second.score) }]
          : []),
      ]
      const cluster = this.assignUnknownCluster(query, simTo(prev), prev, audio, now)
      return {
        clusterKey: cluster.key,
        name: this.displayNameOf(cluster),
        status: 'possible',
        confidence: this.round(match.best.score),
        candidates,
      }
    }

    // ── 4. Unknown speaker (spec §5): stable temporary ids. ─────────────────
    // NOTE: this path can also return a CONTACT-labeled cluster (continuity
    // after a reseed, or a contact known only through the cluster). Status is
    // reported honestly for whichever case applies.
    const cluster = this.assignUnknownCluster(query, simTo(prev), prev, audio, now)
    const bestContactScore = match.best?.score
    if (cluster.contactId) {
      const contact = this.contacts.find((c) => c.contactId === cluster.contactId)
      return {
        clusterKey: cluster.key,
        contactId: cluster.contactId,
        name: contact?.name ?? this.displayNameOf(cluster),
        status: contact ? 'verified' : 'unknown',
        confidence: this.round(
          Math.max(simTo(cluster) || 0, typeof bestContactScore === 'number' ? bestContactScore : 0)
        ),
      }
    }
    return {
      clusterKey: cluster.key,
      name: this.displayNameOf(cluster),
      status: 'unknown',
      confidence: this.round(
        Math.max(simTo(cluster) || 0, typeof bestContactScore === 'number' ? bestContactScore : 0)
      ),
    }
  }

  /**
   * User identification / correction (spec §6/§11/§18): attach a contact or a
   * display name to a cluster. Current-session transcript renames happen on
   * the client via the cluster key; permanent contact creation is a REST call.
   */
  label(
    clusterKey: string,
    opts: { contactId?: string | null; name?: string | null; vector?: number[] | null }
  ): SpeakerInfo | null {
    const cluster = this.clusters.get(clusterKey)
    if (!cluster) return null
    if (opts.contactId !== undefined) cluster.contactId = opts.contactId
    if (opts.name !== undefined && opts.name !== null) cluster.label = opts.name
    if (opts.vector && Array.isArray(opts.vector) && opts.vector.length > 0) {
      const contact = this.contacts.find((c) => c.contactId === cluster.contactId)
      if (!contact) cluster.vector = opts.vector
    }
    if (cluster.contactId) {
      const contact = this.contacts.find((c) => c.contactId === cluster.contactId)
      if (contact) cluster.label = contact.name
    }
    this.previousKey = cluster.key
    return {
      clusterKey: cluster.key,
      contactId: cluster.contactId ?? undefined,
      name: this.displayNameOf(cluster),
      status: cluster.contactId ? 'verified' : 'unknown',
    }
  }

  /**
   * Assemble the enrollment sample for an unknown speaker (spec §6/§7):
   * concatenate the cleanest kept segments (largest first) up to ~12 s.
   * Returns null when not enough usable speech has been collected yet.
   */
  enrollmentSample(clusterKey: string, targetSec = 12): { wavPcm: Buffer; sampleRate: number; speechSec: number } | null {
    const cluster = this.clusters.get(clusterKey)
    if (!cluster || cluster.segments.length === 0) return null
    const segs = [...cluster.segments].sort((a, b) => b.speechSec - a.speechSec)
    const picked: ClusterSegment[] = []
    let total = 0
    for (const s of segs) {
      if (total >= targetSec) break
      picked.push(s)
      total += s.speechSec
    }
    if (total < 2.5) return null // not enough usable speech yet — honest refusal
    const sampleRate = picked[0].sampleRate
    const parts = picked.map((s) => (s.sampleRate === sampleRate ? s.pcm : s.pcm))
    return { wavPcm: Buffer.concat(parts), sampleRate, speechSec: Number(total.toFixed(2)) }
  }

  /** Drop a cluster's stored audio (called after a contact was created). */
  clearSegments(clusterKey: string): void {
    const cluster = this.clusters.get(clusterKey)
    if (cluster) {
      cluster.segments = []
      cluster.totalSpeechSec = 0
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private displayNameOf(cluster: Cluster): string {
    if (cluster.label) return cluster.label
    const n = this.order.indexOf(cluster.key) + 1
    return `Unknown ${n > 0 ? n : this.order.length + 1}`
  }

  private findClusterByContact(contactId: string): Cluster | null {
    for (const key of this.order) {
      const c = this.clusters.get(key)
      if (c && c.contactId === contactId) return c
    }
    return null
  }

  private createCluster(now: number, contactId: string | null, label: string | null): Cluster {
    this.counter += 1
    const key = `spk_${String(this.counter).padStart(3, '0')}`
    const cluster: Cluster = {
      key,
      contactId,
      label,
      vector: null,
      count: 0,
      lastSeenAt: now,
      segments: [],
      totalSpeechSec: 0,
    }
    this.clusters.set(key, cluster)
    this.order.push(key)
    return cluster
  }

  private assignUnknownCluster(
    query: number[],
    simPrev: number,
    prev: Cluster | null | undefined,
    audio: { pcm: Buffer; sampleRate: number; speechSec: number } | undefined,
    now: number
  ): Cluster {
    // Prefer an existing cluster above the merge threshold — INCLUDING contact-
    // labeled ones (continuity across reseeds: a labeled cluster is still the
    // same person; the caller reports the honest status for it).
    let best: Cluster | null = null
    let bestSim = 0
    for (const key of this.order) {
      const c = this.clusters.get(key)
      if (!c) continue
      const sim = c.vector ? cosineSimilarity(query, c.vector) : 0
      if (sim > bestSim) {
        bestSim = sim
        best = c
      }
    }
    if (best && bestSim >= CLUSTER_MERGE_THRESHOLD) {
      this.updateCentroid(best, query)
      // Enrollment audio only accumulates for UNLABELED speakers.
      if (!best.contactId) this.attachSegment(best, audio, now)
      this.previousKey = best.key
      return best
    }
    // Stability: closer to the previous speaker than to any cluster → keep.
    if (prev && !prev.contactId && simPrev >= CLUSTER_MERGE_THRESHOLD && simPrev >= bestSim) {
      this.updateCentroid(prev, query)
      this.attachSegment(prev, audio, now)
      this.previousKey = prev.key
      return prev
    }
    // Otherwise — and ONLY for full-length utterances — a NEW unknown speaker.
    const cluster = this.createCluster(now, null, null)
    this.updateCentroid(cluster, query)
    this.attachSegment(cluster, audio, now)
    this.previousKey = cluster.key
    return cluster
  }

  private updateCentroid(cluster: Cluster, vector: number[]): void {
    if (!cluster.vector) {
      cluster.vector = [...vector]
    } else {
      // Running mean (weight 1/count) — cheap, stable centroid.
      const w = 1 / (cluster.count + 1)
      for (let i = 0; i < cluster.vector.length && i < vector.length; i++) {
        cluster.vector[i] = cluster.vector[i] * (1 - w) + vector[i] * w
      }
    }
    cluster.count += 1
    cluster.lastSeenAt = Date.now()
  }

  private attachSegment(
    cluster: Cluster,
    audio: { pcm: Buffer; sampleRate: number; speechSec: number } | undefined,
    now: number
  ): void {
    if (!audio || cluster.contactId) return // labeled speakers need no enrollment audio
    if (cluster.totalSpeechSec >= MAX_CLUSTER_SPEECH_SEC) return
    cluster.segments.push({ pcm: audio.pcm, sampleRate: audio.sampleRate, speechSec: audio.speechSec, at: now })
    cluster.totalSpeechSec += audio.speechSec
    if (cluster.segments.length > MAX_SEGMENTS_PER_CLUSTER) {
      // Drop the smallest segment to stay bounded.
      cluster.segments.sort((a, b) => b.speechSec - a.speechSec)
      const dropped = cluster.segments.pop()
      if (dropped) cluster.totalSpeechSec -= dropped.speechSec
    }
  }

  private round(v: number | undefined): number | undefined {
    return Number.isFinite(v) ? Math.round((v as number) * 1000) / 1000 : undefined
  }

  /** Non-optional variant for required score fields. */
  private score3(v: number): number {
    return Math.round(v * 1000) / 1000
  }
}
