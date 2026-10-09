'use client'

import { ArrowLeftRight, Gauge, Languages, Lock, Settings2, Mic2, Volume2, RectangleHorizontal, Type, Rows3, MessageSquareOff } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Mode, OtherLang, StyleMode, UIPrefs } from '@/types/translator'
import { LANG_META, OTHER_LANGS } from '@/types/translator'

interface SettingsCardProps {
  style: StyleMode
  onStyleChange: (style: StyleMode) => void
  voiceMode: 'profile' | 'default'
  onVoiceModeChange: (mode: 'profile' | 'default') => void
  hasProfile: boolean
  /** Mode of the ACTIVE profile — drives honest capability labels. */
  profileMode?: 'clone' | 'voice-match'
  mode: Mode
  onModeChange: (mode: Mode) => void
  otherLang: OtherLang
  onOtherLangChange: (lang: OtherLang) => void
  playbackRate: number
  onPlaybackRateChange: (rate: number) => void
  /** Big-button talk mode — oversized push-to-talk for phone interpreters. */
  bigButton: boolean
  onBigButtonChange: (on: boolean) => void
  /** UI customization (spec §4.4) — server-persisted. */
  uiPrefs: UIPrefs
  onTextSizeChange: (size: UIPrefs['textSize']) => void
  onCompactChange: (on: boolean) => void
  onShowTranscriptChange: (on: boolean) => void
}

const STYLE_INFO: Record<StyleMode, string> = {
  clean: 'Softens strong language — safe for general conversation.',
  natural: 'Natural spoken language, matching the tone of the original.',
  literal: 'Stays as close as possible to the original wording.',
  formal: 'Polite, professional register for meetings and interviews.',
  casual: 'Relaxed friendly wording — like chatting with close friends.',
}

const PLAYBACK_RATES: readonly number[] = [0.75, 1, 1.25, 1.5]

export function SettingsCard({
  style,
  onStyleChange,
  voiceMode,
  onVoiceModeChange,
  hasProfile,
  profileMode,
  mode,
  onModeChange,
  otherLang,
  onOtherLangChange,
  playbackRate,
  onPlaybackRateChange,
  bigButton,
  onBigButtonChange,
  uiPrefs,
  onTextSizeChange,
  onCompactChange,
  onShowTranscriptChange,
}: SettingsCardProps) {
  const isDub = mode === 'dub'
  const inputLang = isDub ? LANG_META.fa : LANG_META[otherLang]
  const outputLang = isDub ? LANG_META[otherLang] : LANG_META.fa

  return (
    <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
      <header className="mb-4 flex items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400">
          <Settings2 className="h-3.5 w-3.5" aria-hidden />
        </span>
        <h2 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">Settings</h2>
      </header>

      <div className="space-y-4">
        {/* Mode — Dub (Persian → X) or Interpreter (X → Persian) */}
        <div>
          <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            <ArrowLeftRight className="h-3 w-3" aria-hidden /> Mode
          </label>
          <ToggleGroup
            type="single"
            value={mode}
            onValueChange={(v) => {
              if (v === 'dub' || v === 'interpreter') onModeChange(v)
            }}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/70 p-1"
          >
            <ToggleGroupItem
              value="dub"
              className="flex-1 gap-1.5 rounded-md text-xs transition-colors data-[state=on]:bg-emerald-500/15 data-[state=on]:text-emerald-300 data-[state=on]:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
            >
              <span aria-hidden>🎙</span>
              <span>Dub</span>
            </ToggleGroupItem>
            <ToggleGroupItem
              value="interpreter"
              className="flex-1 gap-1.5 rounded-md text-xs transition-colors data-[state=on]:bg-emerald-500/15 data-[state=on]:text-emerald-300 data-[state=on]:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
            >
              <span aria-hidden>💬</span>
              <span>Interpreter</span>
              <span className="rounded-full border border-amber-500/40 px-1 text-[8px] font-bold leading-4 text-amber-400">
                β
              </span>
            </ToggleGroupItem>
          </ToggleGroup>
          <p className="mt-1.5 text-[11px] leading-snug text-zinc-500">
            {isDub ? (
              <>
                Speak Persian — hear{' '}
                <span className="font-medium text-zinc-300">{LANG_META[otherLang].name}</span> in your
                voice.
              </>
            ) : (
              <>
                Speak{' '}
                <span className="font-medium text-zinc-300">{LANG_META[otherLang].name}</span> — read
                live Persian text.
                <span className="text-amber-500/80"> Persian speech output is accented (β).</span>
              </>
            )}
          </p>
        </div>

        {/* Language of the non-Persian side */}
        <div>
          <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            <Languages className="h-3 w-3" aria-hidden />{' '}
            {isDub ? 'Output language' : 'Input language'}
          </label>
          <Select value={otherLang} onValueChange={(v) => onOtherLangChange(v as OtherLang)}>
            <SelectTrigger
              aria-label="Select the non-Persian language"
              className="w-full border-zinc-800 bg-zinc-900/70 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
            >
              <SelectValue placeholder="Select language" />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-900">
              {OTHER_LANGS.map((code) => (
                <SelectItem key={code} value={code} className="text-sm">
                  <span className="flex items-center gap-2">
                    <span aria-hidden>{LANG_META[code].flag}</span>
                    {LANG_META[code].name}
                    <span className="ml-1 font-mono text-[10px] uppercase text-zinc-500">{code}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {otherLang !== 'en' && (
            <p className="mt-1.5 text-[11px] leading-snug text-amber-500/80">
              {LANG_META[otherLang].name} β: translated text is reliable; the synthesized voice is
              heavily accented for now.
            </p>
          )}
        </div>

        {/* Fixed Persian side (read-only summary) */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              <Mic2 className="h-3 w-3" aria-hidden /> You speak
            </label>
            <div className="flex h-10 items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <span className="flex items-center gap-2">
                <span aria-hidden>{inputLang.flag}</span> {inputLang.name}
              </span>
              <Lock className="h-3 w-3 text-zinc-600" aria-label="Fixed side of the pair" />
            </div>
          </div>
          <div>
            <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              <Volume2 className="h-3 w-3" aria-hidden /> You get
            </label>
            <div className="flex h-10 items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <span className="flex items-center gap-2">
                <span aria-hidden>{outputLang.flag}</span> {outputLang.name}
              </span>
              <Lock className="h-3 w-3 text-zinc-600" aria-label="Fixed side of the pair" />
            </div>
          </div>
        </div>

        {/* Voice mode — honest capability labeling (spec §3.3) */}
        <div>
          <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            <Mic2 className="h-3 w-3" aria-hidden /> Voice Mode
          </label>
          <ToggleGroup
            type="single"
            value={voiceMode}
            onValueChange={(v) => {
              if (v === 'profile' || v === 'default') onVoiceModeChange(v)
            }}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/70 p-1"
          >
            <ToggleGroupItem
              value="profile"
              disabled={!hasProfile}
              className="flex-1 rounded-md text-xs transition-colors data-[state=on]:bg-emerald-500/15 data-[state=on]:text-emerald-300 data-[state=on]:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
            >
              🎙 {profileMode === 'clone' ? 'Voice Clone' : 'Voice Match'}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="default"
              className="flex-1 rounded-md text-xs transition-colors data-[state=on]:bg-emerald-500/15 data-[state=on]:text-emerald-300 data-[state=on]:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
            >
              Default
            </ToggleGroupItem>
          </ToggleGroup>
          <p className="mt-1.5 text-[11px] leading-snug text-zinc-600">
            {hasProfile ? (
              profileMode === 'clone' ? (
                <>
                  <span className="font-medium text-emerald-300">Voice Clone</span> speaks every
                  translation with YOUR enrolled voice — a real cloned voice, not a preset.
                </>
              ) : (
                <>
                  <span className="font-medium text-zinc-400">Voice Match</span> speaks with the studio
                  voice closest to your pitch &amp; tempo — an approximation, not a clone.
                </>
              )
            ) : (
              'Record a voice sample to unlock “Voice Match”.'
            )}
          </p>
        </div>

        {/* Output playback speed */}
        <div>
          <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            <Gauge className="h-3 w-3" aria-hidden /> Playback speed
          </label>
          <ToggleGroup
            type="single"
            value={String(playbackRate)}
            onValueChange={(v) => {
              const rate = Number(v)
              if (PLAYBACK_RATES.includes(rate)) onPlaybackRateChange(rate)
            }}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/70 p-1"
          >
            {PLAYBACK_RATES.map((rate) => (
              <ToggleGroupItem
                key={rate}
                value={String(rate)}
                className="flex-1 rounded-md font-mono text-[11px] transition-colors data-[state=on]:bg-emerald-500/15 data-[state=on]:text-emerald-300 data-[state=on]:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
              >
                {rate}×
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="mt-1.5 text-[11px] leading-snug text-zinc-500">
            {playbackRate === 1
              ? 'Plays translations at normal speed.'
              : playbackRate < 1
                ? 'Slowed down — easier to follow tricky phrases.'
                : 'Sped up — faster playback when you skim results.'}
          </p>
        </div>

        {/* Style — 5 registers (spec §6.1) */}
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Content Style
          </label>
          <Select value={style} onValueChange={(v) => onStyleChange(v as StyleMode)}>
            <SelectTrigger className="w-full border-zinc-800 bg-zinc-900/70 text-sm">
              <SelectValue placeholder="Select style" />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-900">
              <SelectItem value="natural">Natural — real speech</SelectItem>
              <SelectItem value="clean">Clean — family friendly</SelectItem>
              <SelectItem value="formal">Formal — business register</SelectItem>
              <SelectItem value="casual">Casual — friendly chat</SelectItem>
              <SelectItem value="literal">Literal — word-faithful</SelectItem>
            </SelectContent>
          </Select>
          <p className="mt-1.5 text-[11px] leading-snug text-zinc-600">{STYLE_INFO[style]}</p>
        </div>

        {/* Big-button talk mode */}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/70 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          <div className="min-w-0">
            <label
              htmlFor="big-button-toggle"
              className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400"
            >
              <RectangleHorizontal className="h-3 w-3" aria-hidden /> Big-button talk
            </label>
            <p className="mt-1 text-[11px] leading-snug text-zinc-600">
              Oversized hold-to-talk button — made for phones in face-to-face interpreting.
            </p>
          </div>
          <Switch
            id="big-button-toggle"
            checked={bigButton}
            onCheckedChange={onBigButtonChange}
            aria-label="Toggle big-button talk mode"
            className="data-[state=checked]:bg-emerald-600"
          />
        </div>

        {/* Interface preferences (spec §4.4) — persisted, actually affect the UI */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          <label className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            <Type className="h-3 w-3" aria-hidden /> Text size
          </label>
          <ToggleGroup
            type="single"
            value={uiPrefs.textSize}
            onValueChange={(v) => {
              if (v === 'sm' || v === 'md' || v === 'lg') onTextSizeChange(v)
            }}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/70 p-1"
          >
            <ToggleGroupItem value="sm" className="flex-1 rounded-md text-[11px] transition-colors data-[state=on]:bg-emerald-500/15 data-[state=on]:text-emerald-300">
              Small
            </ToggleGroupItem>
            <ToggleGroupItem value="md" className="flex-1 rounded-md text-xs transition-colors data-[state=on]:bg-emerald-500/15 data-[state=on]:text-emerald-300">
              Normal
            </ToggleGroupItem>
            <ToggleGroupItem value="lg" className="flex-1 rounded-md text-sm transition-colors data-[state=on]:bg-emerald-500/15 data-[state=on]:text-emerald-300">
              Large
            </ToggleGroupItem>
          </ToggleGroup>
          <div className="mt-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-snug text-zinc-400">
                <Rows3 className="h-3 w-3 shrink-0 text-zinc-500" aria-hidden />
                Compact layout
              </div>
              <Switch
                checked={uiPrefs.compact}
                onCheckedChange={onCompactChange}
                aria-label="Toggle compact layout"
                className="data-[state=checked]:bg-emerald-600"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-snug text-zinc-400">
                <MessageSquareOff className="h-3 w-3 shrink-0 text-zinc-500" aria-hidden />
                Show live transcript
              </div>
              <Switch
                checked={uiPrefs.showTranscript}
                onCheckedChange={onShowTranscriptChange}
                aria-label="Toggle live transcript visibility"
                className="data-[state=checked]:bg-emerald-600"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
