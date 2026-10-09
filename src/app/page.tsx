'use client'

// ─────────────────────────────────────────────────────────────────────────────
// VoxShift v1.0.0 — main page. App shell with five functional views:
//   Translate · Sessions · Voice Identity · Settings · About/Diagnostics
// The active view syncs to the URL hash so reloads restore context.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Headphones, Keyboard, MessagesSquare, MonitorSmartphone, Radio, Settings } from 'lucide-react'
import { useTranslator } from '@/hooks/use-translator'
import { useWakeLock } from '@/hooks/use-wake-lock'
import { MicOrb } from '@/components/translator/mic-orb'
import { StatusPill } from '@/components/translator/status-pill'
import { PipelineVisual } from '@/components/translator/pipeline-visual'
import { LivePanel } from '@/components/translator/live-panel'
import { TranscriptList } from '@/components/translator/transcript-list'
import { SettingsCard } from '@/components/translator/settings-card'
import { LatencyCard } from '@/components/translator/latency-card'
import { ShortcutsOverlay } from '@/components/translator/shortcuts-overlay'
import { ConversationsDrawer } from '@/components/translator/conversations-drawer'
import { ThreadView } from '@/components/translator/thread-view'
import { AppShell, viewFromHash, type AppView } from '@/components/shell/app-shell'
import { SessionsView } from '@/components/translator/sessions-view'
import { VoiceIdentityView } from '@/components/translator/voice-identity-view'
import { VoiceContactsView } from '@/components/translator/voice-contacts-view'
import { IdentifySpeakerDialog } from '@/components/translator/identify-speaker-dialog'
import { SpeakerChip } from '@/components/translator/speaker-chip'
import { SettingsCenter } from '@/components/translator/settings-center'
import { AboutView } from '@/components/translator/about-view'
import type { StyleMode } from '@/types/translator'
import { LANG_META } from '@/types/translator'
import { cn } from '@/lib/utils'

const APP_VERSION = 'v2.2.0'

export default function LiveTranslatorPage() {
  const t = useTranslator()
  const {
    status, connected, activeStage, level, transcript,
    profile, profiles, profileLoading, capabilities, threadProfileId, effectiveVoiceProfile,
    style, voiceMode, mode, otherLang, playbackRate, playbackActive, bigButton,
    langPair, partial, liveCaption, pendingCount, sessionSpeechMs, sessionLangs,
    stats, lastError, uiPrefs, autoSaveHistory, useContext, showCaptions,
    autoDetect, setAutoDetect, speaker, setSpeaker, availableOtherLangs, betaLangs, setBetaLangs,
    historyRetentionDays, setHistoryRetentionDays,
    start, stop, setStyle, setVoiceMode, setMode, setOtherLang, setPlaybackRate,
    setBigButton, setTextSize, setCompact, setShowTranscript,
    setAutoSaveHistory, setUseContext, setShowCaptions,
    translateText, pushToTalk, replay, downloadAudio, shareTranslation, shareSaved,
    createProfile, selectProfile, renameProfile, deleteProfile, updateCloneSettings,
    clearTranscript, retryFailed, clearError,
    history, historyLoading, historyCursor, loadHistory, loadMoreHistory, clearHistory, toggleStar,
    deleteHistoryEntry,
    conversations, conversationsLoading, activeThread, threadLoading, threadSession,
    loadConversations, openThread, closeThread, createConversation, renameConversation,
    deleteConversation, saveThreadOverrides,
    // v2: voice contacts + speaker recognition + provider health
    contacts, contactsLoading, loadContacts, createContact, updateContact, deleteContact, reenrollContact,
    speakers, identify, startIdentify, cancelIdentify, confirmIdentify, confirmCandidate, keepUnknown, correctSpeaker,
    providerHealth, requestProviderHealth, reloadProviders, lastProviders,
  } = t

  const latest = useMemo(() => transcript[0] ?? null, [transcript])
  const live = status !== 'idle' && status !== 'starting'
  /** Active speaker (v2 §29): the attribution of the most recent phrase. */
  const activeSpeaker = useMemo(
    () => (latest?.speakerKey ? speakers[latest.speakerKey] : undefined),
    [latest, speakers]
  )
  const srcMeta = LANG_META[langPair.sourceLang] ?? LANG_META.fa
  const tgtMeta = LANG_META[langPair.targetLang] ?? LANG_META.en
  const canReplayLatest = Boolean(latest?.hasAudio) && status === 'idle'
  const wakeHeld = useWakeLock(live)

  // ── View routing (hash-synced, spec §4 navigation) ────────────────────────
  /** Subscribe to hashchange so the view survives reloads + back/forward. */
  const subscribeToHash = useCallback((onChange: () => void) => {
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const view = useSyncExternalStore(
    subscribeToHash,
    () => viewFromHash(window.location.hash),
    () => 'translate' as AppView
  )
  const changeView = useCallback((next: AppView) => {
    if (viewFromHash(window.location.hash) === next) return
    window.location.hash = `/${next}`
  }, [])
  // Opening a thread from Sessions jumps to the live workspace.
  const openThreadAndGo = useCallback(
    async (id: string) => {
      const ok = await openThread(id)
      if (ok) changeView('translate')
    },
    [openThread, changeView]
  )

  // ── Conversations drawer (quick thread switching from anywhere) ──────────
  const [drawerOpen, setDrawerOpen] = useState(false)
  useEffect(() => {
    if (drawerOpen) void loadConversations()
  }, [drawerOpen, loadConversations])

  /** Thread playback: audio lives in the HistoryEntry cache. */
  const replayThreadMessage = (historyEntryId: string | null) => {
    if (!historyEntryId) return
    try {
      const audio = new Audio(`/api/history/${historyEntryId}/audio`)
      audio.playbackRate = playbackRate
      void audio.play()
    } catch {
      // playback blocked — ignore
    }
  }

  // ── Presentation mode: jumbo translation text, everything else dims ────
  const [present, setPresent] = useState(false)
  useEffect(() => {
    if (!present) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPresent(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [present])

  // ── Shortcuts overlay (? toggles; ignored while typing) ─────────────────
  const [showShortcuts, setShowShortcuts] = useState(false)
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.repeat || isTypingTarget(e.target)) return
      e.preventDefault()
      setShowShortcuts((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  /** Everything that is not the LivePanel fades + blurs while presenting. */
  const dimCls = `transition-all duration-500 ${present ? 'opacity-20 blur-[1.5px] pointer-events-none select-none' : ''}`

  // ── R = replay the last translation (ignored while typing) ──────────
  const replayLatestRef = useRef<() => void>(() => {})
  useEffect(() => {
    replayLatestRef.current = () => {
      if (canReplayLatest && latest) replay(latest.id)
    }
  }, [canReplayLatest, latest, replay])
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'r' && e.key !== 'R') return
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      if (!canReplayLatest) return
      e.preventDefault()
      replayLatestRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canReplayLatest])

  // ── Push-to-talk: hold SPACE while live (ignored while typing) ───────
  const pttRef = useRef(pushToTalk)
  const liveRef = useRef(live)
  useEffect(() => {
    pttRef.current = pushToTalk
    liveRef.current = live
  }, [pushToTalk, live])

  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || !liveRef.current || isTypingTarget(e.target)) return
      e.preventDefault() // keep the page from scrolling
      pttRef.current(true)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !liveRef.current) return
      e.preventDefault()
      pttRef.current(false)
    }
    // Release capture even if the window loses focus mid-hold
    const onBlur = () => pttRef.current(false)

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  /** Layout density from UI prefs (spec §4.4). */
  const density = uiPrefs.compact ? 'gap-4 py-4' : 'gap-6 py-6 sm:py-8'
  const heroPad = uiPrefs.compact ? 'p-4 sm:p-6' : 'p-6 sm:p-8'

  const globalSettingsLabel = `${LANG_META[mode === 'dub' ? 'fa' : otherLang].name} → ${
    LANG_META[mode === 'dub' ? otherLang : 'fa'].name
  } · ${style}`

  const isTranslating = view === 'translate'

  // Honest static-demo notice: on the GitHub Pages build there is no local
  // backend, so the socket never connects. Show it only after a grace period
  // so a normal local startup never flashes the banner.
  const [staticNotice, setStaticNotice] = useState(false)
  useEffect(() => {
    if (connected) return
    const id = setTimeout(() => setStaticNotice(true), 4000)
    return () => clearTimeout(id)
  }, [connected])

  return (
    <AppShell
      view={view}
      onViewChange={changeView}
      header={
        <header className={`relative border-b border-zinc-800 bg-zinc-950/80 backdrop-blur ${dimCls}`}>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-emerald-500/25 to-transparent"
          />
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
            <button type="button" onClick={() => changeView('translate')} className="flex min-w-0 items-center gap-3 text-left" aria-label="VoxShift home">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 via-emerald-500 to-teal-600 shadow-[0_0_24px_-6px_rgba(16,185,129,0.9),inset_0_1px_0_rgba(255,255,255,0.25)]">
                <Radio className="h-4.5 w-4.5 text-zinc-950" aria-hidden />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-sm font-black uppercase tracking-[0.24em] text-white">
                  Vox<span className="text-emerald-400">Shift</span>
                </h1>
                <p className="truncate text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                  {srcMeta.flag} {srcMeta.name} → {tgtMeta.flag} {tgtMeta.name} ·{' '}
                  {mode === 'dub' ? 'Your Voice' : 'Interpreter β'}
                </p>
              </div>
            </button>
            <div className="flex items-center gap-2">
              {/* Quick thread access (full browser lives in Sessions) */}
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-label="Conversations"
                title="Conversations — persistent, resumable threads"
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 text-zinc-400 transition-colors hover:border-teal-700/60 hover:text-teal-300"
              >
                <MessagesSquare className="h-3.5 w-3.5" aria-hidden />
                <span className="hidden text-[11px] font-semibold sm:inline">Threads</span>
                {activeThread && (
                  <span className="h-1.5 w-1.5 rounded-full bg-teal-400 shadow-[0_0_6px_rgba(45,212,191,0.9)]" aria-hidden />
                )}
              </button>
              {wakeHeld && (
                <span
                  className="hidden items-center gap-1 rounded-full border border-emerald-900/50 bg-emerald-950/30 px-2 py-1 text-[10px] font-medium text-emerald-400 sm:inline-flex"
                  title="Screen kept awake during the live session"
                >
                  <MonitorSmartphone className="h-3 w-3" aria-hidden />
                  Screen awake
                </span>
              )}
              <span className="hidden rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] text-zinc-400 sm:inline">
                {APP_VERSION}
              </span>
              {/* Settings gear (spec §4 — recognizable settings entry point) */}
              <button
                type="button"
                onClick={() => changeView('settings')}
                aria-label="Settings"
                title="Settings"
                className={cn(
                  'inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors',
                  view === 'settings'
                    ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-300'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-emerald-700/60 hover:text-emerald-300'
                )}
              >
                <Settings className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => setShowShortcuts((v) => !v)}
                aria-label="Keyboard shortcuts"
                title="Keyboard shortcuts (?)"
                className="hidden h-8 w-8 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-zinc-400 transition-colors hover:border-emerald-700/60 hover:text-emerald-300 sm:inline-flex"
              >
                <Keyboard className="h-3.5 w-3.5" aria-hidden />
                <span className="hidden font-mono text-[10px] font-bold md:inline">?</span>
              </button>
              <StatusPill status={status} connected={connected} />
            </div>
          </div>
        </header>
      }
      footer={
        <footer className={`relative mt-auto border-t border-zinc-800 bg-zinc-950/80 backdrop-blur ${dimCls}`}>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-500/30 to-transparent"
          />
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-1.5 px-4 py-4 pb-[max(0.875rem,env(safe-area-inset-bottom))] text-[11px] text-zinc-600 sm:flex-row sm:px-6">
            <p>
              <span className="font-semibold text-zinc-400">VoxShift</span> · {APP_VERSION} · Persian ↔
              English · Deutsch · Français · Español · العربية · Türkçe · Italiano · Voice Match ·
              Threads
            </p>
            <p className="font-mono text-[10px] uppercase tracking-wider">
              ASR · AI Translation · Voice Identity — modular engines
            </p>
          </div>
        </footer>
      }
    >
      {/* Static GitHub Pages demo — engine honestly offline */}
      {staticNotice && !connected && (
        <div role="status" className="mx-auto w-full max-w-6xl px-4 pt-3 sm:px-6">
          <p className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-2.5 text-[12px] leading-relaxed text-amber-200/90">
            <span className="font-semibold">Static GitHub Pages demo</span> — the real-time engine
            (ASR · translation · voice) runs only with the local backend. Clone the repo and run it
            locally for full functionality:{' '}
            <a
              className="font-medium underline decoration-amber-700 underline-offset-2 transition-colors hover:text-amber-100"
              href="https://github.com/Dani-Devlop/Vox-Shift"
              target="_blank"
              rel="noreferrer"
            >
              github.com/Dani-Devlop/Vox-Shift
            </a>
          </p>
        </div>
      )}

      {/* ═══ VIEW: Translate ═══════════════════════════════════════════════ */}
      {isTranslating && (
        <div className={cn('flex flex-col', density)}>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-6">
            {/* Left column: console */}
            <div className="lt-enter flex min-w-0 flex-col gap-6">
              {/* Orb + pipeline */}
              <section
                className={cn(
                  'lt-card relative overflow-hidden rounded-2xl border bg-zinc-900/40 transition-colors duration-500',
                  heroPad,
                  live ? 'border-emerald-900/60' : 'border-zinc-800',
                  dimCls
                )}
              >
                <div aria-hidden className="lt-grid-texture pointer-events-none absolute inset-0" />
                <div aria-hidden className="lt-vignette pointer-events-none absolute inset-0" />
                {live && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 opacity-60"
                    style={{
                      background: 'radial-gradient(420px 220px at 50% -40px, rgba(16,185,129,0.12), transparent 70%)',
                    }}
                  />
                )}
                <div className="relative flex flex-col items-center gap-7">
                  <MicOrb status={status} level={level} onStart={() => void start()} onStop={() => void stop()} />
                  {/* Level meter strip while live */}
                  <div className="flex h-2 w-full max-w-xs items-center gap-1" aria-hidden>
                    {Array.from({ length: 28 }).map((_, i) => {
                      const center = Math.abs(i - 13.5) / 13.5
                      const threshold = 1 - center * 0.9
                      const on = live && level > threshold * 0.45
                      return (
                        <span
                          key={i}
                          className={`h-full flex-1 rounded-full transition-colors duration-75 ${
                            on ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]' : 'bg-zinc-800'
                          }`}
                        />
                      )
                    })}
                  </div>
                  <PipelineVisual
                    activeStage={activeStage}
                    status={status}
                    voiceName={
                      voiceMode === 'profile' && effectiveVoiceProfile
                        ? effectiveVoiceProfile.mode === 'clone'
                          ? `Voice Clone → ${effectiveVoiceProfile.name}`
                          : `Voice Match → ${effectiveVoiceProfile.mappedVoice} ×${effectiveVoiceProfile.pitchRatio?.toFixed(2)}`
                        : 'Default'
                    }
                    sourceLangName={srcMeta.name}
                    targetLangName={tgtMeta.name}
                  />
                  {/* Active speaker — real recognition, honest status (§29) */}
                  <div className="flex items-center gap-2" aria-live="polite">
                    <SpeakerChip
                      info={activeSpeaker}
                      fallback={latest?.speakerRole === 'B' ? 'Speaker B' : latest ? 'Speaker A' : undefined}
                      onStartIdentify={startIdentify}
                      onConfirmCandidate={confirmCandidate}
                      onKeepUnknown={keepUnknown}
                    />
                  </div>
                </div>
              </section>

              <div className={dimCls}>
                <LivePanel
                  latest={latest}
                  status={status}
                  activeStage={activeStage}
                  langPair={langPair}
                  partial={partial}
                  liveCaption={liveCaption}
                  pendingCount={pendingCount}
                  canReplay={canReplayLatest}
                  onReplay={() => latest && replay(latest.id)}
                  onDownload={latest?.hasAudio ? () => downloadAudio(latest.id, latest.translated) : undefined}
                  onShare={latest ? () => void shareTranslation(latest.id, latest.translated, latest.translated) : undefined}
                  onTranslateText={translateText}
                  onPushToTalk={live ? pushToTalk : undefined}
                  bigButton={bigButton}
                  present={present}
                  onTogglePresent={() => setPresent((v) => !v)}
                  abProfile={effectiveVoiceProfile ? { mappedVoice: effectiveVoiceProfile.mappedVoice, speedAdjust: effectiveVoiceProfile.speedAdjust, pitchRatio: effectiveVoiceProfile.pitchRatio } : null}
                  abProfileId={effectiveVoiceProfile?.id ?? null}
                  playbackActive={playbackActive}
                  lastError={lastError}
                  onRetryFailed={lastError?.payload ? () => retryFailed() : undefined}
                  onDismissError={clearError}
                  textScale={uiPrefs.textSize}
                  speaker={speaker}
                  onSpeakerChange={setSpeaker}
                  speakerNote={
                    'Speaker recognition is automatic (local voiceprints): known contacts are named, unknown voices get stable “Unknown N” labels — never a guess. The A/B switch below forces the translation direction for each side.'
                  }
                />
              </div>

              {/* Thread view (persisted conversation) replaces the live transcript */}
              <div className={dimCls}>
                {activeThread ? (
                  <ThreadView
                    thread={activeThread}
                    voiceProfiles={profiles.map((p) => ({ id: p.id, name: p.name, mode: p.mode }))}
                    globalSettingsLabel={globalSettingsLabel}
                    liveSessionActive={live && threadSession?.status === 'live'}
                    onClose={() => closeThread()}
                    onRename={(id, title) => renameConversation(id, title)}
                    onSaveOverrides={(overrides) => saveThreadOverrides(overrides)}
                    onReplay={(m) => replayThreadMessage(m.historyEntryId)}
                  />
                ) : uiPrefs.showTranscript ? (
                  <TranscriptList
                    entries={transcript}
                    onClear={clearTranscript}
                    onReplay={replay}
                    speakers={speakers}
                    onStartIdentify={startIdentify}
                    onConfirmCandidate={confirmCandidate}
                    onKeepUnknown={keepUnknown}
                  />
                ) : null}
              </div>
            </div>

            {/* Right column: controls */}
            <div className={`lt-enter lt-enter-d1 flex flex-col gap-6 ${dimCls}`}>
              <SettingsCard
                style={style}
                onStyleChange={(s: StyleMode) => setStyle(s)}
                voiceMode={voiceMode}
                onVoiceModeChange={setVoiceMode}
                hasProfile={!!effectiveVoiceProfile}
                profileMode={effectiveVoiceProfile?.mode}
                mode={mode}
                onModeChange={setMode}
                otherLang={otherLang}
                onOtherLangChange={setOtherLang}
                autoDetect={autoDetect}
                onAutoDetectChange={setAutoDetect}
                availableLangs={availableOtherLangs}
                playbackRate={playbackRate}
                onPlaybackRateChange={setPlaybackRate}
                bigButton={bigButton}
                onBigButtonChange={setBigButton}
                uiPrefs={uiPrefs}
                onTextSizeChange={setTextSize}
                onCompactChange={setCompact}
                onShowTranscriptChange={setShowTranscript}
              />
              <LatencyCard stats={stats} speechMs={sessionSpeechMs} langsUsed={sessionLangs} />
            </div>
          </div>

          {/* Headphone tip */}
          <p className={cn('mx-auto mt-6 flex max-w-xl items-center justify-center gap-2 text-center text-[11px] leading-relaxed text-zinc-600', dimCls)}>
            <Headphones className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
            Tip: use headphones to hear your dubbing without feedback — the mic pauses while output
            plays, so the translation is never re-heard as new speech.
          </p>
        </div>
      )}

      {/* ═══ VIEW: Sessions ════════════════════════════════════════════════ */}
      {view === 'sessions' && (
        <SessionsView
          conversations={conversations}
          conversationsLoading={conversationsLoading}
          activeThreadId={activeThread?.conversation.id ?? null}
          onLoad={loadConversations}
          onOpenThread={openThreadAndGo}
          onCreate={createConversation}
          onRename={renameConversation}
          onDelete={deleteConversation}
          history={history}
          historyLoading={historyLoading}
          historyCursor={historyCursor}
          onLoadHistory={loadHistory}
          onLoadMoreHistory={() => loadMoreHistory()}
          onClearHistory={clearHistory}
          onToggleStar={(id) => toggleStar(id)}
          onDeleteHistory={(id) => deleteHistoryEntry(id)}
          onShareSaved={(entry) => void shareSaved(entry.id, entry.translated, entry.translated, entry.hasAudio)}
          onReuse={(entry) => void translateText(entry.source)}
          playbackRate={playbackRate}
          historyCount={history?.length ?? 0}
        />
      )}

      {/* ═══ VIEW: Voice Contacts ══════════════════════════════════════════ */}
      {view === 'contacts' && (
        <VoiceContactsView
          contacts={contacts}
          loading={contactsLoading}
          onLoad={() => void loadContacts()}
          onCreate={createContact}
          onUpdate={updateContact}
          onDelete={deleteContact}
          onReenroll={reenrollContact}
        />
      )}

      {/* ═══ VIEW: Voice Identity ══════════════════════════════════════════ */}
      {view === 'voice' && (
        <VoiceIdentityView
          profile={profile}
          profiles={profiles}
          loading={profileLoading}
          capabilities={capabilities}
          onCreate={createProfile}
          onSelect={selectProfile}
          onRename={renameProfile}
          onDelete={deleteProfile}
          onUpdateClone={updateCloneSettings}
          previewLang={langPair.targetLang}
        />
      )}

      {/* ═══ VIEW: Settings ════════════════════════════════════════════════ */}
      {view === 'settings' && (
        <SettingsCenter
          mode={mode}
          otherLang={otherLang}
          style={style}
          voiceMode={voiceMode}
          playbackRate={playbackRate}
          bigButton={bigButton}
          textSize={uiPrefs.textSize}
          compact={uiPrefs.compact}
          showTranscript={uiPrefs.showTranscript}
          autoSaveHistory={autoSaveHistory}
          useContext={useContext}
          showCaptions={showCaptions}
          profiles={profiles}
          profile={profile}
          onModeChange={setMode}
          onOtherLangChange={setOtherLang}
          onStyleChange={setStyle}
          onVoiceModeChange={setVoiceMode}
          onPlaybackRateChange={setPlaybackRate}
          onBigButtonChange={setBigButton}
          onTextSizeChange={setTextSize}
          onCompactChange={setCompact}
          onShowTranscriptChange={setShowTranscript}
          onAutoSaveHistoryChange={setAutoSaveHistory}
          onUseContextChange={setUseContext}
          onShowCaptionsChange={setShowCaptions}
          autoDetect={autoDetect}
          onAutoDetectChange={setAutoDetect}
          betaLangs={betaLangs}
          onBetaLangsChange={setBetaLangs}
          historyRetentionDays={historyRetentionDays}
          onHistoryRetentionDaysChange={setHistoryRetentionDays}
          availableLangs={availableOtherLangs}
          onOpenSelfTest={() => changeView('about')}
          onSelectProfile={selectProfile}
          onClearHistory={clearHistory}
          historyCount={history?.length ?? 0}
          providerHealth={providerHealth}
          onRequestProviderHealth={requestProviderHealth}
          onReloadProviders={reloadProviders}
        />
      )}

      {/* ═══ VIEW: About · Diagnostics ═════════════════════════════════════ */}
      {view === 'about' && <AboutView connected={connected} speaker={speaker} />}

      {threadLoading && (
        <div className="fixed inset-x-0 top-16 z-50 flex justify-center" aria-live="polite">
          <span className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 shadow-lg">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" aria-hidden />
            Opening conversation…
          </span>
        </div>
      )}

      {/* Conversations drawer (quick access) */}
      <ConversationsDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        conversations={conversations}
        loading={conversationsLoading}
        activeThreadId={activeThread?.conversation.id ?? null}
        onLoad={(q) => void loadConversations(q)}
        onOpenThread={(id) => void openThread(id)}
        onCreate={(title) => createConversation(title)}
        onRename={renameConversation}
        onDelete={deleteConversation}
      />

      {/* Keyboard shortcut cheat-sheet (? key / header button) */}
      <ShortcutsOverlay open={showShortcuts} onClose={() => setShowShortcuts(false)} />

      {/* Unknown-speaker enrollment dialog (spec v2 §6/§7/§11) — keyed so each
          identification starts from a fresh mount (name input reset, etc.). */}
      <IdentifySpeakerDialog
        key={`${identify?.clusterKey ?? 'none'}-${identify ? 'open' : 'closed'}`}
        open={Boolean(identify)}
        clusterKey={identify?.clusterKey ?? ''}
        phase={identify?.phase ?? 'loading'}
        sample={identify?.sample}
        error={identify?.error}
        onConfirm={confirmIdentify}
        onCancel={cancelIdentify}
      />
    </AppShell>
  )
}
