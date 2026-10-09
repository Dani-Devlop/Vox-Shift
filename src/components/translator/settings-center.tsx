'use client'

// ─────────────────────────────────────────────────────────────────────────────
// SettingsCenter — the dedicated Settings view (spec §6).
// Every control is real, persisted (localStorage + server preferences) and
// reflected in actual behavior: translation direction & style, context
// retention, partial-transcription display, voice profile & mode, playback
// speed, UI customization, data & privacy (auto-save, deletion, retention
// policy), and Reset-to-defaults with confirmation.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import {
  Activity, AudioWaveform, Check, Database, KeyRound, Languages, PlugZap, RotateCcw, Route, ShieldCheck, Sparkles,
} from 'lucide-react'
import type { RealtimeEvent } from '@/types/translator'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { LANG_META, type OtherLang, type StyleMode } from '@/types/translator'
import type { VoiceProfileData } from '@/hooks/use-translator'
import { cn } from '@/lib/utils'

const STYLES: { id: StyleMode; label: string; hint: string }[] = [
  { id: 'natural', label: 'Natural', hint: 'Conversational — preserves meaning and tone (default)' },
  { id: 'clean', label: 'Clean', hint: 'Softens strong language with a clear, disclosed policy' },
  { id: 'literal', label: 'Literal', hint: 'Stays closer to the original wording' },
  { id: 'formal', label: 'Formal', hint: 'Professional register for work settings' },
  { id: 'casual', label: 'Casual', hint: 'Friendly everyday chat' },
]

const STYLE_IDS: readonly StyleMode[] = ['clean', 'natural', 'literal', 'formal', 'casual']
const RATES = [0.75, 1, 1.25, 1.5]

export interface SettingsCenterProps {
  mode: 'dub' | 'interpreter'
  otherLang: OtherLang
  style: StyleMode
  voiceMode: 'profile' | 'default'
  playbackRate: number
  bigButton: boolean
  textSize: 'sm' | 'md' | 'lg'
  compact: boolean
  showTranscript: boolean
  autoSaveHistory: boolean
  useContext: boolean
  showCaptions: boolean
  profiles: VoiceProfileData[]
  profile: VoiceProfileData | null
  /** AUTO direction + language availability + retention (v1.2). */
  autoDetect: boolean
  betaLangs: boolean
  historyRetentionDays: number
  availableLangs: readonly OtherLang[]
  onModeChange: (m: 'dub' | 'interpreter') => void
  onOtherLangChange: (l: OtherLang) => void
  onStyleChange: (s: StyleMode) => void
  onVoiceModeChange: (v: 'profile' | 'default') => void
  onPlaybackRateChange: (r: number) => void
  onBigButtonChange: (v: boolean) => void
  onTextSizeChange: (v: 'sm' | 'md' | 'lg') => void
  onCompactChange: (v: boolean) => void
  onShowTranscriptChange: (v: boolean) => void
  onAutoSaveHistoryChange: (v: boolean) => void
  onUseContextChange: (v: boolean) => void
  onShowCaptionsChange: (v: boolean) => void
  onAutoDetectChange: (v: boolean) => void
  onBetaLangsChange: (v: boolean) => void
  onHistoryRetentionDaysChange: (days: number) => void
  /** Navigate to the Info view (full self-test with real per-stage probes). */
  onOpenSelfTest: () => void
  onSelectProfile: (id: string) => Promise<boolean>
  onClearHistory: () => Promise<void>
  historyCount: number
  /** v2: user-registered providers + live health (§24/§30). */
  providerHealth?: { providerId: string; name: string; category: string; state: string; lastError?: string; consecutiveFailures: number }[] | null
  onRequestProviderHealth?: () => void
  onReloadProviders?: () => void
  /** v3 §25: provider routing policy + §27 realtime event feed. */
  routingPolicy?: string
  onRoutingPolicyChange?: (policy: string) => void
  realtimeEvents?: RealtimeEvent[]
}

export function SettingsCenter(p: SettingsCenterProps) {
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetDone, setResetDone] = useState(false)

  // Provider/connection status — REAL server report (GET /api/diagnostics:
  // config booleans + DB check only; no secrets). Fails honestly when the
  // backend is absent (e.g. the static GitHub Pages demo).
  const [providerStatus, setProviderStatus] = useState<{
    loaded: boolean
    offline: boolean
    providers?: Record<string, { configured?: boolean; engine?: string; setup?: { steps: string[] } | null }>
    database?: { ok?: boolean }
  }>({ loaded: false, offline: false })
  useEffect(() => {
    let cancelled = false
    fetch('/api/diagnostics', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        if (!cancelled) setProviderStatus({ loaded: true, offline: false, providers: data?.providers, database: data?.database })
      })
      .catch(() => {
        if (!cancelled) setProviderStatus({ loaded: true, offline: true })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const resetDefaults = () => {
    p.onModeChange('dub')
    p.onOtherLangChange('en')
    p.onStyleChange('natural')
    p.onVoiceModeChange('profile')
    p.onPlaybackRateChange(1)
    p.onBigButtonChange(false)
    p.onTextSizeChange('md')
    p.onCompactChange(false)
    p.onShowTranscriptChange(true)
    p.onAutoSaveHistoryChange(true)
    p.onUseContextChange(true)
    p.onShowCaptionsChange(true)
    p.onAutoDetectChange(false)
    p.onHistoryRetentionDaysChange(0)
    setConfirmReset(false)
    setResetDone(true)
    window.setTimeout(() => setResetDone(false), 2500)
  }

  return (
    <div className="lt-enter mx-auto flex max-w-3xl flex-col gap-6">
      {/* ── Translation (spec §6.3) ───────────────────────────────────────── */}
      <SettingsSection icon={Languages} title="Translation" hint="Applies to new sessions; threads can override locally.">
        {/* AUTO direction — real bidirectional conversation */}
        <SettingToggle
          label="Auto-detect language (two-way)"
          hint={`Detect the spoken language per phrase and translate to the other side (${LANG_META.fa.name} ↔ ${LANG_META[p.otherLang].name}). Enables real two-person interpreter conversations.`}
          checked={p.autoDetect}
          onChange={p.onAutoDetectChange}
          className="border-teal-900/50 bg-teal-950/20"
        />
        <div className={cn('grid gap-4 sm:grid-cols-2', p.autoDetect && 'pointer-events-none opacity-40')}>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px] uppercase tracking-wider text-zinc-500">Direction</Label>
            <Select value={p.mode} onValueChange={(v) => p.onModeChange(v as 'dub' | 'interpreter')}>
              <SelectTrigger className="h-9 border-zinc-800 bg-zinc-900 text-sm focus-visible:ring-emerald-500/60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900">
                <SelectItem value="dub">Persian → {LANG_META[p.otherLang].name} (your voice)</SelectItem>
                <SelectItem value="interpreter">{LANG_META[p.otherLang].name} → Persian (interpreter)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px] uppercase tracking-wider text-zinc-500">Other language</Label>
            <Select value={p.otherLang} onValueChange={(v) => p.onOtherLangChange(v as OtherLang)}>
              <SelectTrigger className="h-9 border-zinc-800 bg-zinc-900 text-sm focus-visible:ring-emerald-500/60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900">
                {p.availableLangs.map((l) => (
                  <SelectItem key={l} value={l}>
                    {LANG_META[l].flag} {LANG_META[l].name}
                    {LANG_META[l].tts === 'beta' && <span className="ml-1 text-[9px] font-bold text-amber-400">β</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-1 flex flex-col gap-2">
          <Label className="text-[11px] uppercase tracking-wider text-zinc-500">Style</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" role="radiogroup" aria-label="Translation style">
            {STYLES.map((s) => {
              const active = p.style === s.id
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  title={s.hint}
                  onClick={() => p.onStyleChange(s.id)}
                  className={cn(
                    'flex min-h-[40px] items-center justify-center rounded-xl border px-2 text-xs font-semibold transition-colors',
                    active
                      ? 'border-emerald-600 bg-emerald-600/15 text-emerald-300'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                  )}
                >
                  {s.label}
                </button>
              )
            })}
          </div>
          <p className="text-[11px] text-zinc-600">{STYLES.find((s) => s.id === p.style)?.hint}</p>
        </div>

        <SettingToggle
          className="mt-1"
          label="Conversation context"
          hint="Keep recent phrases so pronouns, names and topics stay consistent. Off = every phrase translates standalone."
          checked={p.useContext}
          onChange={p.onUseContextChange}
        />
        <SettingToggle
          label="Live captions"
          hint="Show partial speech-to-text while you are still speaking (spec §6.3 partial transcription display)."
          checked={p.showCaptions}
          onChange={p.onShowCaptionsChange}
        />
      </SettingsSection>

      {/* ── Voice (spec §6.2) ─────────────────────────────────────────────── */}
      <SettingsSection icon={AudioWaveform} title="Voice" hint="Only options the current engine genuinely supports are shown.">
        <div className="flex flex-col gap-1.5">
          <Label className="text-[11px] uppercase tracking-wider text-zinc-500">Output voice</Label>
          <Select value={p.voiceMode} onValueChange={(v) => p.onVoiceModeChange(v as 'profile' | 'default')}>
            <SelectTrigger className="h-9 border-zinc-800 bg-zinc-900 text-sm focus-visible:ring-emerald-500/60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-900">
              <SelectItem value="profile" disabled={!p.profile}>
                {p.profile
                  ? p.profile.mode === 'clone'
                    ? `My voice — ${p.profile.name} (real clone)`
                    : `My voice — ${p.profile.name} (${p.profile.mappedVoice} ×${p.profile.pitchRatio?.toFixed(2)})`
                  : 'My voice — enroll first in Voice Identity'}
              </SelectItem>
              <SelectItem value="default">Interpreter default (kazi)</SelectItem>
            </SelectContent>
          </Select>
          {p.profiles.length > 1 && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {p.profiles.map((prof) => (
                <button
                  key={prof.id}
                  type="button"
                  onClick={() => void p.onSelectProfile(prof.id)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                    prof.id === p.profile?.id
                      ? 'border-emerald-600 bg-emerald-600/15 text-emerald-300'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                  )}
                >
                  {prof.name}
                  {prof.mode === 'clone' && (
                    <span className="ml-1 rounded-full bg-emerald-500/10 px-1 text-[9px] font-bold uppercase text-emerald-400">clone</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {p.voiceMode === 'profile' && !p.profile && (
            <p className="text-[11px] text-amber-300/90">
              No voice profile yet — the interpreter default is used until you enroll in Voice
              Identity. Nothing is silently substituted: this fallback is labeled everywhere.
            </p>
          )}
        </div>

        <div className="mt-1 flex flex-col gap-1.5">
          <Label className="text-[11px] uppercase tracking-wider text-zinc-500">
            Playback speed — currently ×{p.playbackRate}
          </Label>
          <div className="flex gap-2" role="radiogroup" aria-label="Playback speed">
            {RATES.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={p.playbackRate === r}
                onClick={() => p.onPlaybackRateChange(r)}
                className={cn(
                  'h-9 flex-1 rounded-xl border font-mono text-xs font-semibold transition-colors',
                  p.playbackRate === r
                    ? 'border-emerald-600 bg-emerald-600/15 text-emerald-300'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                )}
              >
                ×{r}
              </button>
            ))}
          </div>
        </div>
      </SettingsSection>

      {/* ── Interface (spec §6.5) ─────────────────────────────────────────── */}
      <SettingsSection icon={Sparkles} title="Interface" hint="Dark console is the product identity; density and text size adapt to you.">
        <div className="flex flex-col gap-1.5">
          <Label className="text-[11px] uppercase tracking-wider text-zinc-500">Translation text size</Label>
          <div className="flex gap-2" role="radiogroup" aria-label="Text size">
            {(['sm', 'md', 'lg'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={p.textSize === s}
                onClick={() => p.onTextSizeChange(s)}
                className={cn(
                  'h-9 flex-1 rounded-xl border text-xs font-semibold transition-colors',
                  s === 'sm' && 'text-[11px]',
                  s === 'lg' && 'text-sm',
                  p.textSize === s
                    ? 'border-emerald-600 bg-emerald-600/15 text-emerald-300'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                )}
              >
                {s === 'sm' ? 'Compact' : s === 'md' ? 'Default' : 'Large'}
              </button>
            ))}
          </div>
        </div>
        <SettingToggle className="mt-1" label="Compact layout" hint="Tighter spacing for small screens." checked={p.compact} onChange={p.onCompactChange} />
        <SettingToggle label="Show session transcript" hint="The running list of phrases under the translation panel." checked={p.showTranscript} onChange={p.onShowTranscriptChange} />
        <SettingToggle label="Big-button talk mode" hint="Oversized push-to-talk button — built for phone interpreters." checked={p.bigButton} onChange={p.onBigButtonChange} />
        <SettingToggle
          label="Beta (β) languages"
          hint="German, French, Spanish, Arabic, Turkish, Italian: translation is reliable, but the synthesized voice is heavily accented. Off = only English (native-quality voice) is offered."
          checked={p.betaLangs}
          onChange={p.onBetaLangsChange}
        />
      </SettingsSection>

      {/* ── Data & privacy (spec §6.1 + §12) ──────────────────────────────── */}
      <SettingsSection icon={Database} title="Data &amp; privacy" hint="What VoxShift stores, for how long, and how to remove it.">
        <SettingToggle
          label="Automatically save translations"
          hint="Save each completed phrase to Saved Phrases so you can search, star and replay them. Off = nothing is written."
          checked={p.autoSaveHistory}
          onChange={p.onAutoSaveHistoryChange}
        />
        {/* REAL retention control — enforced server-side on every history load */}
        <div className="flex flex-col gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
          <Label className="text-xs font-semibold text-zinc-200">Auto-delete saved phrases older than</Label>
          <Select value={String(p.historyRetentionDays)} onValueChange={(v) => p.onHistoryRetentionDaysChange(Number(v))}>
            <SelectTrigger className="h-9 border-zinc-800 bg-zinc-900 text-sm focus-visible:ring-emerald-500/60" aria-label="History retention period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-900">
              <SelectItem value="0">Never — keep everything</SelectItem>
              <SelectItem value="7">7 days</SelectItem>
              <SelectItem value="30">30 days</SelectItem>
              <SelectItem value="90">90 days</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-relaxed text-zinc-500">
            {p.historyRetentionDays === 0
              ? 'Text history is kept until you delete it. Audio is cached separately (rolling cap) and deleted with its phrase.'
              : `Unstarred phrases older than ${p.historyRetentionDays} days (and their audio) are deleted automatically — enforced on the server, not just hidden.`}
          </p>
        </div>
        <div className="mt-1 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-[11px] leading-relaxed text-zinc-400">
          <p className="mb-1 flex items-center gap-1.5 font-semibold text-zinc-300">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" aria-hidden /> Retention policy
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              Voice-match samples are analyzed in memory and <span className="text-zinc-200">never stored</span> — only
              the numeric profile (pitch, brightness, tempo) is kept.
              {p.profile?.mode === 'clone' && (
                <>
                  {' '}Cloned profiles differ: your sample is stored by ElevenLabs to power the clone, and deleting the
                  profile deletes it there too.
                </>
              )}
            </li>
            <li>Translation audio is cached server-side so replays survive reloads; deleting a saved phrase deletes its audio.</li>
            <li>Synthesized audio is generated per request by the voice provider — it does not retain your conversations.</li>
            <li>API credentials live only on the server — never in the browser.</li>
          </ul>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!confirmClear ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmClear(true)}
              className="h-8 gap-1.5 border-zinc-700 bg-zinc-900 text-xs text-rose-300 hover:bg-rose-950/40 hover:text-rose-200"
            >
              <Database className="h-3.5 w-3.5" aria-hidden /> Clear saved phrases{p.historyCount > 0 ? ` (${p.historyCount})` : ''}
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-zinc-400">Delete all saved phrases and audio? This cannot be undone.</span>
              <Button size="sm" onClick={() => { void p.onClearHistory(); setConfirmClear(false) }} className="h-8 bg-rose-600 px-3 text-xs hover:bg-rose-500">
                Yes, delete all
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmClear(false)} className="h-8 border-zinc-700 px-3 text-xs">
                Cancel
              </Button>
            </div>
          )}
        </div>
      </SettingsSection>

      {/* ── Providers & connection (v1.2) — REAL status from the server ──── */}
      <SettingsSection
        icon={PlugZap}
        title="Providers &amp; connection"
        hint="Live status reported by the backend (no secrets). Run the full self-test in Info for real per-stage requests."
      >
        {providerStatus.offline ? (
          <p className="rounded-xl border border-amber-900/50 bg-amber-950/30 p-3 text-[11px] leading-relaxed text-amber-200/90">
            Provider status is unavailable — the backend is not reachable (static demo or server down). Run VoxShift locally for the full engine.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <ProviderChip
              label="ASR (speech-to-text)"
              engine={providerStatus.providers?.asr?.engine}
              configured={providerStatus.providers?.asr?.configured}
            />
            <ProviderChip
              label="Translation (LLM)"
              engine={providerStatus.providers?.translation?.engine}
              configured={providerStatus.providers?.translation?.configured}
            />
            <ProviderChip
              label="TTS (speech synthesis)"
              engine={providerStatus.providers?.voice?.engine}
              configured={providerStatus.providers?.voice?.configured}
            />
            <ProviderChip
              label="Voice cloning (ElevenLabs)"
              engine={providerStatus.providers?.voiceClone?.engine}
              configured={providerStatus.providers?.voiceClone?.configured}
            />
            <ProviderChip
              label="Database (SQLite)"
              engine="prisma"
              configured={providerStatus.database?.ok}
            />
          </div>
        )}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-zinc-300">
            <KeyRound className="h-3.5 w-3.5 text-emerald-500" aria-hidden /> API keys &amp; environment
          </p>
          <p className="text-[11px] leading-relaxed text-zinc-500">
            Keys live ONLY on the server (<code className="rounded bg-zinc-800 px-1 font-mono text-[10px]">.env</code>) and are never sent to the browser.
            {providerStatus.providers?.voiceClone?.configured
              ? ' Voice cloning is configured.'
              : ' To enable real voice cloning add ELEVENLABS_API_KEY:'}
          </p>
          {!providerStatus.providers?.voiceClone?.configured &&
            providerStatus.providers?.voiceClone?.setup?.steps?.length ? (
            <ol className="list-decimal space-y-0.5 pl-4 text-[11px] leading-relaxed text-zinc-400">
              {providerStatus.providers.voiceClone.setup.steps.map((st, i) => (
                <li key={i}>{st}</li>
              ))}
            </ol>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={p.onOpenSelfTest}
          className="h-8 w-fit gap-1.5 border-zinc-700 bg-zinc-900 text-xs hover:bg-zinc-800"
        >
          <PlugZap className="h-3.5 w-3.5" aria-hidden /> Run full self-test (real requests)
        </Button>

        {/* ── Custom providers (v2 §24): bring your own API keys ─────────── */}
        <CustomProvidersCard
          health={p.providerHealth ?? null}
          onRequestHealth={p.onRequestProviderHealth}
          onReload={p.onReloadProviders}
        />

        {/* ── v3 §25: routing policy — real, applies to the very next call ── */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-zinc-300">
            <Route className="h-3.5 w-3.5 text-teal-400" aria-hidden /> Routing policy
          </p>
          <Select value={p.routingPolicy ?? 'failover'} onValueChange={(v) => p.onRoutingPolicyChange?.(v)}>
            <SelectTrigger className="h-9 border-zinc-800 bg-zinc-900 text-sm focus-visible:ring-emerald-500/60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-900">
              {ROUTING_POLICIES.map((pol) => (
                <SelectItem key={pol.id} value={pol.id} className="text-xs">
                  {pol.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
            Every attempt is real and recorded — the result carries the provider that actually served each stage, and
            failures broadcast <code className="rounded bg-zinc-800 px-1 font-mono text-[10px]">provider.failed</code> /{' '}
            <code className="rounded bg-zinc-800 px-1 font-mono text-[10px]">provider.fallback</code> events live.
          </p>
        </div>

        {/* ── v3 §27: live realtime event feed (real backend events only) ── */}
        {p.realtimeEvents && p.realtimeEvents.length > 0 && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-zinc-300">
              <Activity className="h-3.5 w-3.5 text-emerald-400" aria-hidden /> Realtime events (latest first)
            </p>
            <ul className="max-h-44 space-y-1 overflow-y-auto pr-1">
              {p.realtimeEvents.map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-2 rounded border border-zinc-800/70 bg-zinc-950/50 px-2 py-1">
                  <span className="font-mono text-[10px] text-emerald-300">{e.type}</span>
                  <span className="min-w-0 flex-1 truncate text-right text-[10px] text-zinc-500">{e.detail ?? ''}</span>
                  <span className="shrink-0 font-mono text-[9px] text-zinc-600">
                    {new Date(e.at).toLocaleTimeString([], { hour12: false })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </SettingsSection>

      {/* ── Reset (spec §6.6) ─────────────────────────────────────────────── */}
      <section className="lt-card flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 sm:p-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          </span>
          <div>
            <h2 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">Reset</h2>
            <p className="text-[11px] text-zinc-500">Restore every setting above to its default. Voice profiles and saved phrases are untouched.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {resetDone && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400" aria-live="polite">
              <Check className="h-3.5 w-3.5" aria-hidden /> Defaults restored
            </span>
          )}
          {!confirmReset ? (
            <Button variant="outline" size="sm" onClick={() => setConfirmReset(true)} className="h-8 gap-1.5 border-zinc-700 bg-zinc-900 text-xs hover:bg-zinc-800">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset to defaults
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={resetDefaults} className="h-8 bg-emerald-600 px-3 text-xs hover:bg-emerald-500">
                Confirm reset
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmReset(false)} className="h-8 border-zinc-700 px-3 text-xs">
                Cancel
              </Button>
            </>
          )}
        </div>
      </section>
    </div>
  )
}

function SettingsSection({
  icon: Icon, title, hint, children,
}: {
  icon: typeof Languages
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
      <header className="mb-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400">
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
          <h2 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">{title}</h2>
        </div>
        {hint && <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">{hint}</p>}
      </header>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  )
}

function SettingToggle({
  label, hint, checked, onChange, className,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3', className)}>
      <div className="min-w-0">
        <Label className="text-xs font-semibold text-zinc-200">{label}</Label>
        <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} className="shrink-0" />
    </div>
  )
}

function ProviderChip({ label, engine, configured }: { label: string; engine?: string; configured?: boolean }) {
  const state = configured === undefined ? 'checking' : configured ? 'ok' : 'missing'
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-[11px] font-semibold text-zinc-200">{label}</p>
        {engine && <p className="truncate font-mono text-[9px] uppercase text-zinc-600">{engine}</p>}
      </div>
      <span
        className={cn(
          'shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider',
          state === 'ok' && 'border-emerald-700/60 bg-emerald-950/40 text-emerald-400',
          state === 'missing' && 'border-amber-700/60 bg-amber-950/40 text-amber-400',
          state === 'checking' && 'border-zinc-700 bg-zinc-900 text-zinc-500'
        )}
      >
        {state === 'ok' ? 'CONFIGURED' : state === 'missing' ? 'MISSING' : '…'}
      </span>
    </div>
  )
}

// ── Custom providers card (v2 §24) ───────────────────────────────────────────
// Users register their own OpenAI-compatible endpoints (ASR / translation /
// TTS). Keys are encrypted at rest server-side and NEVER returned (masked
// hint only). The failover chain tries these first, then the built-ins, and
// the ACTUAL provider used is recorded on every result (§23).

const PROVIDER_CATEGORIES = [
  { id: 'asr', label: 'ASR (speech-to-text)', endpoint: '/audio/transcriptions', model: 'whisper-1' },
  { id: 'translate', label: 'Translation (chat)', endpoint: '/chat/completions', model: 'gpt-4o-mini' },
  { id: 'llm', label: 'LLM / reasoning', endpoint: '/chat/completions', model: 'qwen2.5:3b-instruct' },
  { id: 'tts', label: 'TTS (speech synthesis)', endpoint: '/audio/speech', model: 'tts-1' },
] as const

/** Provider classes (v3 §15) — LOCAL runtimes are auto-detected, not added. */
const PROVIDER_CLASSES = [
  { id: 'server', label: 'Server (self-hosted)', hint: 'Your own machine/VPS — e.g. Ollama, vLLM, whisper.cpp server' },
  { id: 'cloud', label: 'Cloud/API', hint: 'A hosted API with a key' },
  { id: 'custom', label: 'Custom', hint: 'Anything OpenAI-compatible' },
] as const

const ROUTING_POLICIES = [
  { id: 'auto', label: 'AUTO — smart default (quality-lean)' },
  { id: 'local_first', label: 'LOCAL_FIRST — on-machine runtimes first' },
  { id: 'server_first', label: 'SERVER_FIRST — self-hosted endpoints first' },
  { id: 'quality_first', label: 'QUALITY_FIRST — built-in cloud first' },
  { id: 'low_cost', label: 'LOW_COST — free/local before paid' },
  { id: 'privacy_first', label: 'PRIVACY_FIRST — never leaves the machine (no cloud fallback)' },
  { id: 'manual', label: 'MANUAL — only your first registered provider' },
  { id: 'failover', label: 'FAILOVER — registered → built-in → local' },
] as const

interface ProviderRowMasked {
  id: string
  category: string
  class?: string
  name: string
  baseUrl: string
  model: string | null
  voiceId: string | null
  headerCount?: number
  hasKey: boolean
  keyHint: string | null
  priority: number
  enabled: boolean
}

function CustomProvidersCard({
  health,
  onRequestHealth,
  onReload,
}: {
  health: { providerId: string; name: string; category: string; state: string; lastError?: string; consecutiveFailures: number }[] | null
  onRequestHealth?: () => void
  onReload?: () => void
}) {
  const [rows, setRows] = useState<ProviderRowMasked[] | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [category, setCategory] = useState<'asr' | 'translate' | 'llm' | 'tts'>('translate')
  const [providerClass, setProviderClass] = useState<'server' | 'cloud' | 'custom'>('custom')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [headers, setHeaders] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const load = async () => {
    try {
      const res = await fetch('/api/providers', { cache: 'no-store' })
      const data = await res.json()
      setRows(Array.isArray(data?.providers) ? data.providers : [])
    } catch {
      setRows([])
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const healthOf = (id: string) => health?.find((h) => h.providerId === id)

  const create = async () => {
    if (!name.trim() || !baseUrl.trim()) return
    setBusy('create')
    setMsg(null)
    try {
      const res = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          class: providerClass,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim() || undefined,
          model: model.trim() || undefined,
          voiceId: voiceId.trim() || undefined,
          headers: headers.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Request failed')
      setName('')
      setBaseUrl('')
      setApiKey('')
      setModel('')
      setVoiceId('')
      setHeaders('')
      setFormOpen(false)
      setMsg({ kind: 'ok', text: `“${data.provider.name}” saved — the router orders it by priority and records it on every result.` })
      await load()
      onReload?.()
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Could not save the provider' })
    } finally {
      setBusy(null)
    }
  }

  const testProvider = async (id: string) => {
    setBusy(id)
    setMsg(null)
    try {
      const res = await fetch(`/api/providers?action=test&id=${encodeURIComponent(id)}`, { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        setMsg({ kind: 'ok', text: `Connection OK (${data.ms} ms)${data.detail ? ` — ${JSON.stringify(data.detail).slice(0, 140)}` : ''}` })
      } else {
        setMsg({ kind: 'err', text: `Real test failed (${data.code ?? 'ERROR'}, ${data.ms ?? 0} ms): ${data.message ?? 'unknown'}` })
      }
      onRequestHealth?.()
    } catch {
      setMsg({ kind: 'err', text: 'The test request itself failed — backend unreachable.' })
    } finally {
      setBusy(null)
    }
  }

  const toggle = async (row: ProviderRowMasked) => {
    setBusy(row.id)
    try {
      await fetch('/api/providers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, enabled: !row.enabled }),
      })
      await load()
      onReload?.()
    } finally {
      setBusy(null)
    }
  }

  const remove = async (id: string) => {
    setBusy(id)
    try {
      await fetch(`/api/providers?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      await load()
      onReload?.()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-300">
          <KeyRound className="h-3.5 w-3.5 text-teal-400" aria-hidden /> Custom providers (bring your own API)
        </p>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => onRequestHealth?.()} title="Request live health from the engine">
            Refresh health
          </Button>
          <Button variant="outline" size="sm" className="h-7 gap-1 border-zinc-700 bg-zinc-900 px-2 text-[11px]" onClick={() => setFormOpen((v) => !v)}>
            {formOpen ? 'Close' : 'Add provider'}
          </Button>
        </div>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
        OpenAI-compatible endpoints are tried BEFORE the built-in engines, in priority order, with automatic
        failover. Keys are AES-256-GCM encrypted on the server and never returned to the browser.
      </p>

      {formOpen && (
        <div className="mt-3 grid gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Category</span>
            <div className="flex flex-wrap gap-1.5">
              {PROVIDER_CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategory(c.id)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
                    category === c.id
                      ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-300'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <span className="mt-1 block font-mono text-[10px] text-zinc-600">
              {PROVIDER_CATEGORIES.find((c) => c.id === category)?.endpoint}
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Class (§15)</span>
            <div className="flex flex-wrap gap-1.5">
              {PROVIDER_CLASSES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setProviderClass(c.id)}
                  title={c.hint}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
                    providerClass === c.id
                      ? 'border-teal-600/60 bg-teal-950/40 text-teal-300'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Display name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Ollama server" className="h-8 text-xs" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Base URL</span>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:11434/v1" className="h-8 text-xs" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              API key (stored encrypted — optional for localhost servers)
            </span>
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-… (empty for keyless local runtimes)" className="h-8 text-xs" autoComplete="off" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Model + Voice ID (optional)</span>
            <div className="flex gap-1.5">
              <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={PROVIDER_CATEGORIES.find((c) => c.id === category)?.model} className="h-8 text-xs" />
              <Input value={voiceId} onChange={(e) => setVoiceId(e.target.value)} placeholder="voice" className="h-8 w-24 text-xs" />
            </div>
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Additional headers (JSON — values stay server-side)</span>
            <Input value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder='{"X-Tenant":"acme","X-Region":"eu"}' className="h-8 font-mono text-xs" autoComplete="off" />
          </label>
          <div className="sm:col-span-2">
            <Button size="sm" onClick={() => void create()} disabled={busy === 'create' || !name.trim() || !baseUrl.trim()} className="h-8 bg-emerald-600 text-xs text-white hover:bg-emerald-500">
              Save provider
            </Button>
          </div>
        </div>
      )}

      {msg && (
        <p
          className={cn(
            'mt-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed',
            msg.kind === 'ok'
              ? 'border-emerald-900/50 bg-emerald-950/30 text-emerald-200'
              : 'border-amber-900/50 bg-amber-950/30 text-amber-200'
          )}
          role="status"
        >
          {msg.text}
        </p>
      )}

      <ul className="mt-2 space-y-1.5">
        {rows === null ? (
          <li className="py-2 text-center text-[11px] text-zinc-600">Loading…</li>
        ) : rows.length === 0 ? (
          <li className="rounded-lg border border-dashed border-zinc-800 px-3 py-3 text-center text-[11px] text-zinc-600">
            No custom providers — the built-in engines serve every stage. Add one to route through your own keys.
          </li>
        ) : (
          rows.map((r) => {
            const h = healthOf(r.id)
            const state = !r.enabled ? 'DISABLED' : (h?.state ?? 'READY')
            return (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-semibold text-zinc-200">
                    {r.name}
                    <span className="ml-1.5 font-mono text-[9px] uppercase text-zinc-600">{r.category}</span>
                  </p>
                  <p className="truncate font-mono text-[10px] text-zinc-600">
                    {r.baseUrl}
                    {r.model ? ` · ${r.model}` : ''}
                    {r.hasKey ? ` · key …${r.keyHint ?? '••••'}` : ' · NO KEY'}
                  </p>
                  {h?.lastError && (
                    <p className="truncate text-[10px] text-amber-500/90" title={h.lastError}>
                      {h.lastError}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider',
                      state === 'READY'
                        ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-400'
                        : state === 'DISABLED'
                          ? 'border-zinc-700 bg-zinc-900 text-zinc-500'
                          : 'border-amber-700/60 bg-amber-950/40 text-amber-400'
                    )}
                    title={`Provider health state (real, from the engine): ${state}`}
                  >
                    {state}
                  </span>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={busy === r.id} onClick={() => void testProvider(r.id)}>
                    Test
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={busy === r.id} onClick={() => void toggle(r)}>
                    {r.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-red-400 hover:text-red-300" disabled={busy === r.id} onClick={() => void remove(r.id)}>
                    Delete
                  </Button>
                </div>
              </li>
            )
          })
        )}
      </ul>
    </div>
  )
}
