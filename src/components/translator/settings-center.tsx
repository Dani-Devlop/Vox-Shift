'use client'

// ─────────────────────────────────────────────────────────────────────────────
// SettingsCenter — the dedicated Settings view (spec §6).
// Every control is real, persisted (localStorage + server preferences) and
// reflected in actual behavior: translation direction & style, context
// retention, partial-transcription display, voice profile & mode, playback
// speed, UI customization, data & privacy (auto-save, deletion, retention
// policy), and Reset-to-defaults with confirmation.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react'
import {
  AudioWaveform, Check, Database, Languages, RotateCcw, ShieldCheck, Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { OTHER_LANGS, LANG_META, type OtherLang, type StyleMode } from '@/types/translator'
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
  onSelectProfile: (id: string) => Promise<boolean>
  onClearHistory: () => Promise<void>
  historyCount: number
}

export function SettingsCenter(p: SettingsCenterProps) {
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetDone, setResetDone] = useState(false)

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
    setConfirmReset(false)
    setResetDone(true)
    window.setTimeout(() => setResetDone(false), 2500)
  }

  return (
    <div className="lt-enter mx-auto flex max-w-3xl flex-col gap-6">
      {/* ── Translation (spec §6.3) ───────────────────────────────────────── */}
      <SettingsSection icon={Languages} title="Translation" hint="Applies to new sessions; threads can override locally.">
        <div className="grid gap-4 sm:grid-cols-2">
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
                {OTHER_LANGS.map((l) => (
                  <SelectItem key={l} value={l}>
                    {LANG_META[l].flag} {LANG_META[l].name}
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
      </SettingsSection>

      {/* ── Data & privacy (spec §6.1 + §12) ──────────────────────────────── */}
      <SettingsSection icon={Database} title="Data &amp; privacy" hint="What VoxShift stores, for how long, and how to remove it.">
        <SettingToggle
          label="Automatically save translations"
          hint="Save each completed phrase to Saved Phrases so you can search, star and replay them. Off = nothing is written."
          checked={p.autoSaveHistory}
          onChange={p.onAutoSaveHistoryChange}
        />
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
