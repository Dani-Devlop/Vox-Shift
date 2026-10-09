// Generates z-ai studio TTS reference clips for the benchmark (jam/kazi voices).
import ZAI from 'z-ai-web-dev-sdk'
import { writeFileSync } from 'fs'

const SENT = 'سلام، حالت چطوره؟ امروز کلی کار داشتم ولی در کل روز خوبی بود.'
const OUT = '/home/z/my-project/voxshift-ml/bench/audio'

const zai = await ZAI.create()
for (const voice of ['jam', 'kazi']) {
  let wav = null
  for (let a = 0; a < 3 && !wav; a++) {
    try {
      const r = await zai.audio.tts.create({ input: SENT, voice, speed: 1.0, response_format: 'wav' })
      wav = Buffer.from(new Uint8Array(await r.arrayBuffer()))
    } catch (e) {
      console.error(`voice=${voice} attempt=${a} err=${String(e).slice(0, 120)}`)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  if (!wav) {
    console.error(`ZAI_TTS_FAILED voice=${voice}`)
    continue
  }
  writeFileSync(`${OUT}/refzai_${voice}.wav`, wav)
  console.log(`ZAI_TTS_OK ${voice} bytes=${wav.length}`)
}
