'use client'

import { motion } from 'framer-motion'
import { Mic, Brain, Languages, AudioWaveform, Volume2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PipelineStage } from '@/types/translator'
import type { TranslatorStatus } from '@/hooks/use-translator'

interface PipelineVisualProps {
  activeStage: PipelineStage | null
  status: TranslatorStatus
  voiceName: string
  /** Names of the current input/output languages for the MIC/OUTPUT nodes. */
  sourceLangName: string
  targetLangName: string
}

interface Node {
  /** 'voice' is the identity stage between translate and output (maps to 'tts'). */
  key: PipelineStage | 'mic' | 'voice' | 'speaker'
  label: string
  /** Compact label for <sm screens — keeps the row's min-content inside narrow viewports. */
  short: string
  sub: string
  icon: typeof Mic
}

const STAGE_BY_NODE: Record<string, PipelineStage | null> = {
  asr: 'asr',
  translate: 'translate',
  voice: 'tts',
  speaker: 'tts',
}

export function PipelineVisual({
  activeStage,
  status,
  voiceName,
  sourceLangName,
  targetLangName,
}: PipelineVisualProps) {
  const live = status !== 'idle' && status !== 'starting'

  const NODES: Node[] = [
    { key: 'mic', label: 'MIC', short: 'MIC', sub: `${sourceLangName} speech`, icon: Mic },
    { key: 'asr', label: 'ASR', short: 'ASR', sub: 'Speech → text', icon: AudioWaveform },
    { key: 'translate', label: 'TRANSLATE', short: 'AI', sub: 'AI · context aware', icon: Languages },
    { key: 'voice', label: 'VOICE', short: 'VOICE', sub: 'Voice identity', icon: Brain },
    { key: 'speaker', label: 'OUTPUT', short: 'OUT', sub: `${targetLangName} audio`, icon: Volume2 },
  ]

  return (
    <div className="flex w-full items-stretch justify-between gap-0" role="list" aria-label="Translation pipeline">
      {NODES.map((node, i) => {
        const stage = STAGE_BY_NODE[node.key]
        const isNodeActive = live && stage !== undefined && stage !== null && activeStage === stage
        const isMicActive = live && node.key === 'mic' && (status === 'user-speaking' || activeStage === null)
        const isSpeakerActive = live && node.key === 'speaker' && status === 'speaking'
        const active = isNodeActive || isMicActive || isSpeakerActive

        return (
          <div key={node.key} className="flex min-w-0 flex-1 items-center" role="listitem">
            <motion.div
              animate={{ scale: active ? 1.06 : 1, y: active ? -2 : 0 }}
              transition={{ type: 'spring', stiffness: 350, damping: 24 }}
              className={cn(
                'flex min-w-0 flex-1 flex-col items-center gap-1.5 rounded-xl border px-1.5 py-3 transition-colors duration-300',
                active
                  ? 'border-emerald-500/60 bg-emerald-500/10 shadow-[0_0_24px_-8px_rgba(16,185,129,0.8),inset_0_1px_0_rgba(255,255,255,0.06)]'
                  : live
                    ? 'border-zinc-800 bg-zinc-900/60'
                    : 'border-zinc-800 bg-zinc-900/30'
              )}
            >
              <node.icon
                className={cn(
                  'h-5 w-5 transition-all duration-300',
                  active
                    ? 'text-emerald-400 drop-shadow-[0_0_8px_rgba(16,185,129,0.7)]'
                    : live
                      ? 'text-zinc-400'
                      : 'text-zinc-600'
                )}
                aria-hidden
              />
              <span
                className={cn(
                  'truncate text-[10px] font-bold tracking-wider sm:text-xs',
                  active ? 'text-emerald-300' : live ? 'text-zinc-300' : 'text-zinc-500'
                )}
              >
                <span className="sm:hidden" aria-hidden>{node.short}</span>
                <span className="hidden sm:inline">{node.label}</span>
              </span>
              <span className="hidden truncate text-[10px] text-zinc-500 sm:block">
                {node.key === 'voice' ? voiceName : node.sub}
              </span>
            </motion.div>
            {i < NODES.length - 1 && (
              <div
                aria-hidden
                className={cn('h-0.5 w-3 shrink-0 sm:w-5', active && STAGE_BY_NODE[NODES[i + 1].key] === activeStage ? 'lt-dash-active' : 'lt-dash-idle')}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
