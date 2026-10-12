# راهنمای کامل راه‌اندازی VoxShift — صفر تا صد

> این سند ترجمهٔ فارسیِ [راهنمای Zero-to-hundred در README](../README.md#zero-to-hundred-setup-guide)
> است و دقیقاً مطابق کدِ مخزن نوشته شده — همهٔ مسیرها و متغیرها همان چیزی‌اند
> که برنامه واقعاً بررسی می‌کند. نسخهٔ برنامه: **v3.8**

این راهنما شما را از یک ماشین خالی تا VoxShiftِ کاملاً روشن همراهی می‌کند:
تشخیص گفتار محلی (فارسی + انگلیسی)، تبدیل متن به گفتار محلی، **کلون واقعی
صدا** (یا ماهواره/ساتلایت)، و کلیدهای ابری.

---

## فهرست

- [گام ۰ — پیش‌نیازها](#گام-۰--پیشنیازها)
- [گام ۱ — اجرای خود برنامه (۵ دقیقه)](#گام-۱--اجرای-خود-برنامه-۵-دقیقه)
- [گام ۲ — محیط پایتون برای موتورهای محلی](#گام-۲--محیط-پایتون-برای-موتورهای-محلی)
- [گام ۳ — مدل‌های تشخیص گفتار محلی (vosk — فارسی و انگلیسی)](#گام-۳--مدلهای-تشخیص-گفتار-محلی-vosk--فارسی-و-انگلیسی)
- [گام ۴ — صداهای تبدیل متن به گفتار (piper)](#گام-۴--صداهای-تبدیل-متن-به-گفتار-piper)
- [گام ۵ — کلون واقعی صدا (موتورهای محلی)](#گام-۵--کلون-واقعی-صدا-موتورهای-محلی)
- [گام ۶ — کلون با ماهواره (ساتلایت) برای کانتینرهای کوچک](#گام-۶--کلون-با-ماهواره-ساتلایت-برای-کانتینرهای-کوچک)
- [گام ۷ — کلیدهای ابری (اختیاری)](#گام-۷--کلیدهای-ابری-اختیاری)
- [گام ۸ — اتصال همهچیز به هم (نقشهٔ متغیرها)](#گام-۸--اتصال-همهچیز-به-هم-نقشهٔ-متغیرها)
- [گام ۹ — تأیید صحت کل زنجیره](#گام-۹--تأیید-صحت-کل-زنجیره)
- [گام ۱۰ — عیب‌یابی](#گام-۱۰--عیبیابی)

---

## گام ۰ — پیش‌نیازها

- **سیستم‌عامل**: لینوکس یا مک (ویندوز: از WSL2 استفاده کنید).
- **Bun** نسخه ۱.۱ به بالا:
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- **Python 3.10 تا 3.12** به‌همراه `pip` و `venv`.
- **بودجهٔ RAM و دیسک** — برنامه *صادقانه* موتوری را که حافظهٔ کافی نداشته باشد
  اجرا نمی‌کند و دلیلش را در صفحهٔ About نشان می‌دهد:

| جزء | حداقل RAM (برای لود) | دیسک | نقش |
| --- | --- | --- | --- |
| vosk فارسی (`vosk-model-small-fa-0.42`) | ~۱۵۰ مگابایت | ~۵۰ مگابایت | تشخیص گفتار فارسی — اصلی |
| vosk انگلیسی (`vosk-model-small-en-us-0.15`) | ~۱۵۰ مگابایت | ~۴۰ مگابایت | تشخیص گفتار انگلیسی — پشتیبان |
| faster-whisper tiny | گارد ۳۵۰ مگابایت | **داخل مخزن هست** (۷۵ مگابایت) | انگلیسی + تشخیص خودکار زبان + ادغام کد-سوئیچینگ |
| صداهای piper (امیر / amy / ryan) | ~۸۰ مگابایت برای هر صدا | ۶۰–۱۱۰ مگابایت هرکدام | تبدیل متن به گفتار محلی |
| **Fish Speech نسخه ۱.۵** | **۲۶۰۰ مگابایت** | ~۱.۵ گیگابایت | کلون صدا بدون تنظیم (zero-shot) |
| **F5-TTS** | **۲۹۰۰ مگابایت** | ~۱.۴ گیگابایت | کلون صدا zero-shot |
| **Chatterbox** | **۲۶۰۰ مگابایت** | ۲–۴ گیگابایت | کلون صدا zero-shot |
| ElevenLabs IVC (ابری) | ۰ | ۰ | کلون واقعی بدون RAM |
| Timbre-conformed (پردازش سیگنال) | ۰ | ۰ | همیشه در دسترس |

- یک پوشه برای مدل‌ها به نام `MODELS_ROOT` (پیش‌فرض **`/home/z/models`**؛ با
  `VOXSHIFT_MODELS_DIR` عوضش کنید). هر چیزی زیر این پوشه باشد **به‌طور خودکار
  پیدا می‌شود**.

---

## گام ۱ — اجرای خود برنامه (۵ دقیقه)

```bash
git clone https://github.com/Dani-Devlop/Vox-Shift.git
cd Vox-Shift
cp .env.example .env          # فقط DATABASE_URL الزامی است
bun install
bun run db:push               # ساخت/همگام‌سازی دیتابیس SQLite

# ترمینال ۱ — برنامهٔ Next.js:
bun run dev                   # http://localhost:3000

# ترمینال ۲ — سرویس بلادرنگ مترجم:
cd mini-services/translator-service
bun install                   # socket.io + prisma + z-ai sdk
bunx prisma generate          # بازتولید کلاینت Prisma برای این سرویس
bun run dev                   # socket.io روی پورت 3003
```

`http://localhost:3000` را باز کنید. از همین لحظه **ترجمهٔ تایپی کار می‌کند**
(سطح بدون‌کلید `free:gtx-translate` به هیچ تنظیمی نیاز ندارد). خط میکروفون
همین‌که مدل‌های گام‌های بعد را نصب کنید فعال می‌شود.

---

## گام ۲ — محیط پایتون برای موتورهای محلی

سرویس مترجم برای پایتون این ترتیب را بررسی می‌کند: `python3` روی PATH، سپس
`/opt/voxshift/venv/bin/python3`، سپس `/home/z/.venv/bin/python`. توصیه — یک
venv اختصاصی بسازید:

```bash
python3 -m venv /home/z/.venv
/home/z/.venv/bin/pip install --upgrade pip
/home/z/.venv/bin/pip install vosk piper-tts faster-whisper numpy soundfile
```

- `vosk` → سطح تشخیص گفتار محلی؛ `piper-tts` → سطح تبدیل متن به گفتار محلی.
- `faster-whisper` → ورکر ساکنِ انگلیسی/تشخیص خودکار زبان (مدل ۷۵ مگابایتی CT2
  **همین‌طور داخل مخزن هست** در `mini-services/translator-service/whisper-tiny-ct2/`
  — نه دانلود می‌خواهد نه دسترسی به HuggingFace).

---

## گام ۳ — مدل‌های تشخیص گفتار محلی (vosk — فارسی و انگلیسی)

ساختار پوشه‌ها مهم است: دو پوشهٔ مدل باید **مستقیم زیر** `MODELS_ROOT` باشند
(بدون پوشهٔ اضافه):

```bash
MODELS_DIR="${VOXSHIFT_MODELS_DIR:-/home/z/models}"
mkdir -p "$MODELS_DIR" && cd "$MODELS_DIR"

curl -LO https://alphacephei.com/vosk/models/vosk-model-small-fa-0.42.zip
curl -LO https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip
unzip -q vosk-model-small-fa-0.42.zip
unzip -q vosk-model-small-en-us-0.15.zip

# نتیجه (بررسی کنید):
ls "$MODELS_DIR"
# vosk-model-small-fa-0.42/  vosk-model-small-en-us-0.15/  (…)
```

تمام کارِ نصبِ تشخیص گفتار فارسی همین بود — با ری‌استارت بعدیِ سرویس مترجم،
`local:vosk-asr` فعال می‌شود و فارسی را با دقت بسیار بالا تشخیص می‌دهد.

---

## گام ۴ — صداهای تبدیل متن به گفتار (piper)

```bash
MODELS_DIR="${VOXSHIFT_MODELS_DIR:-/home/z/models}"
mkdir -p "$MODELS_DIR/piper" && cd "$MODELS_DIR/piper"

# نکته: حتماً از مسیر /resolve/v1.0.0/ استفاده کنید — resolve/main دیگر 404 می‌دهد.
BASE=https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0

# صدای فارسی (امیر):
curl -LO $BASE/fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx
curl -LO $BASE/fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx.json

# صدای انگلیسی زن (amy):
curl -LO $BASE/en/en_US/amy/medium/en_US-amy-medium.onnx
curl -LO $BASE/en/en_US/amy/medium/en_US-amy-medium.onnx.json

# اختیاری — صدای مردانه برای تطبیق طنین (مسیر timbre وقتی صدای مرجع بم باشد):
curl -LO $BASE/en/en_US/ryan/high/en_US-ryan-high.onnx
curl -LO $BASE/en/en_US/ryan/high/en_US-ryan-high.onnx.json
```

هر فایل `.onnx` **باید** فایل `.onnx.json` کنارش باشد — وگرنه piper آن صدا را
نمی‌پذیرد. ورکرها به‌ازای زبان خروجی از قبل گرم می‌شوند و بعد از ۴ دقیقه بی‌کاری
خودکار تخلیه می‌شوند.

---

## گام ۵ — کلون واقعی صدا (موتورهای محلی)

زنجیرهٔ اولویت این است: **Fish Speech → F5-TTS → Chatterbox → ماهواره →
ElevenLabs → timbre-conformed → pitch-conformed**؛ اولین سطحی که هر سه گیتش
(پکیج ✓ · وزن‌ها ✓ · RAM ✓) را رد شود، کلون را سرو می‌کند. دو راه نصب:

### راه الف — نصب‌کنندهٔ یک‌مرحله‌ای (fish + f5؛ حدود ۳ گیگ RAM آزاد می‌خواهد)

```bash
cd Vox-Shift
bash scripts/setup-local-clone.sh              # هر دو موتور + وزن‌ها
#   bash scripts/setup-local-clone.sh --with-fish   # فقط fish
#   bash scripts/setup-local-clone.sh --with-f5     # فقط f5
```

این اسکریپت جفتِ torch سی‌پی‌یو را پین می‌کند (`torch==2.8.0` +
`torchaudio==2.8.0` — عمداً از `pip install -e .` خود fish-speech استفاده
نمی‌کند چون torch را برای بقیهٔ موتورها downgrade می‌کند)، حداقل وابستگی‌های
استنتاج fish را نصب و وزن‌های `fishaudio/fish-speech-1.5` را دانلود می‌کند.

### راه ب — کاملاً دستی (همان کاری که اسکریپت می‌کند، قدم‌به‌قدم)

```bash
MODELS_DIR="${VOXSHIFT_MODELS_DIR:-/home/z/models}"
PY=/home/z/.venv/bin/pip     # pip مخصوص venv خودتان

# ── F5-TTS ──────────────────────────────────────────────────────────
$PY install f5-tts            # وزن‌ها دفعهٔ اولِ سنتز از HF دانلود می‌شوند
                              # (SWivid/F5-TTS) — یا از قبل بگذارید و
                              # VOXSHIFT_F5_WEIGHTS را به آن پوشه اشاره دهید

# ── Fish Speech نسخه 1.5.0 ─────────────────────────────────────────
git clone --depth 1 --branch v1.5.0 \
  https://github.com/fishaudio/fish-speech.git "$MODELS_DIR/fish-speech-src"
$PY install hydra-core einops librosa loguru loralib pyrootutils \
  "einx[torch]==0.2.2" "vector-quantize-pytorch==1.14.24" tiktoken cachetools \
  silero-vad pytorch-lightning lightning natsort
$PY install huggingface_hub
export MODELS_DIR
python3 - <<EOF
from huggingface_hub import snapshot_download
snapshot_download("fishaudio/fish-speech-1.5",
    local_dir="${MODELS_DIR}/fish-speech/checkpoints/fish-speech-1.5",
    allow_patterns=["model.pth", "config.json", "special_tokens.json",
                    "tokenizer.tiktoken",
                    "firefly-gan-vq-fsq-8x1024-21hz-generator.pth"])
EOF

# ── Chatterbox (venv جداگانه! torch مخصوص خودش را پین می‌کند) ────────
python3 -m venv /home/z/.venv-chatterbox
/home/z/.venv-chatterbox/bin/pip install chatterbox-tts
```

> **کدام پایتون؟** تشخیص‌دهندهٔ کلون و ورکر کلون، `python3` سادهٔ PATH را صدا
> می‌زنند. پس یا fish/f5 را در همان مفسری نصب کنید که `python3` به آن می‌رسد،
> **یا قبل از استارتِ سرویس مترجم venv را فعال کنید**
> (`source /home/z/.venv/bin/activate`). چترباکس venv خودش را دارد — وقتی
> می‌خواهید چترباکس موتورِ فعال باشد همان venv را فعال کنید (در هر لحظه فقط یک
> درخت torch می‌تواند مالک `python3` باشد؛ زنجیره هر ۳۰ ثانیه دوباره بررسی
> می‌کند). vosk / piper / faster-whisper بخشنده‌ترند: اجراکننده‌های آن‌ها
> `/opt/voxshift/venv` و `/home/z/.venv` را هم مستقیم بررسی می‌کنند.

### ساختار نهایی پوشهٔ مدل‌ها (همه خودکار پیدا می‌شوند)

```
$MODELS_DIR/
├── vosk-model-small-fa-0.42/
├── vosk-model-small-en-us-0.15/
├── piper/
│   ├── fa_IR-amir-medium.onnx (+ .onnx.json)
│   ├── en_US-amy-medium.onnx  (+ .onnx.json)
│   └── en_US-ryan-high.onnx   (+ .onnx.json)
├── fish-speech-src/                            # checkout نسخه v1.5.0
├── fish-speech/checkpoints/fish-speech-1.5/    # وزن‌ها
├── f5-tts/                                     # وزن‌ها (یا HF cache — هر دو بررسی می‌شوند)
└── chatterbox/                                 # وزن‌ها (یا HF cache)
```

### متنِ رونویسیِ مرجع (توصیه‌شده)

موتورهای zero-shot روی متنِ صدای مرجع شرط می‌شوند (f5 بدون آن وسط کار یک مدل
whisper دانلود می‌کند!). بعد از ثبتِ پروفایل صدا، فایل `<profileId>.txt` را کنار
`<profileId>.wav` در `db/audio/clone-ref/` بگذارید، یا `VOXSHIFT_CLONE_REF_TEXT`
را تنظیم کنید.

**بعد از هر نصب، سرویس مترجم را ری‌استارت کنید** — نتیجهٔ تشخیص ۳۰ ثانیه کش
می‌شود؛ بعدش صفحهٔ About وضعیت واقعی گیتِ هر سطح را با نشان **ACTIVE** روی
موتورِ فعال نشان می‌دهد.

---

## گام ۶ — کلون با ماهواره (ساتلایت) برای کانتینرهای کوچک

اگر برنامه روی هاستی با حافظهٔ محدود اجرا می‌شود (مثل اسلایس ~۱ گیگابایتی
Railway) ولی یک ماشین پر-RAM دارید (کامپیوتر شخصی یا سرور)، موتورهای **واقعی**
کلون را آنجا اجرا کنید و برنامه از طریق HTTP از آن‌ها استفاده کند — بدون ارتقای
پلن:

```bash
# ── روی ماشین پر-RAM ────────────────────────────────────────────────
git clone https://github.com/Dani-Devlop/Vox-Shift.git && cd Vox-Shift
bash scripts/setup-local-clone.sh        # موتورها + وزن‌ها (+ venv چترباکس)
bun mini-services/clone-satellite/server.ts     # روی پورت 3011 گوش می‌دهد
# متغیرها: VOXSATELLITE_PORT / VOXSATELLITE_ENGINES=fish-speech,f5-tts,chatterbox
#          VOXSATELLITE_ALLOW_ORIGINS=https://your-app-host  (اختیاری — CORS)

# در دسترس‌سازی: تونل SSH / Tailscale / ngrok / port-forward، بعد تست:
curl http://<your-host>:3011/healthz      # → {"ok":true,"engines":[…]}

# ── روی هاست برنامه ─────────────────────────────────────────────────
# در .env:
VOXSHIFT_SATELLITE_CLONE_URL=http://<your-host>:3011
```

زنجیره، ساتلایت را در اولویت ۴ (قبل از ElevenLabs) قرار می‌دهد؛ نتیجه‌ها کلون
**واقعی** هستند (`degraded:false`) و هر درخواست یک ورکر یک‌باره روی ساتلایت
می‌سازد — آنجا هم RAM ساکن اشغال نمی‌شود.

---

## گام ۷ — کلیدهای ابری (اختیاری)

| کلید | اثر |
| --- | --- |
| `ELEVENLABS_API_KEY` | **کلون واقعی بین‌زبانی** با ElevenLabs IVC — سطح ۵ زنجیره. |
| موتورهای داخلی `z-ai` (ASR · ترجمه · TTS) | با کانفیگ خودِ SDK فعال می‌شوند (`/etc/.z-ai-config` یا متغیرهای محیطی سرور). بدون آن این سطوح **صادقانه UNCONFIGURED** گزارش می‌شوند و سطوح محلی + بدون‌کلید کل خط لوله را سرپا نگه می‌دارند. |
| ارائه‌دهنده‌های سفارشیِ سازگار با OpenAI | Settings → Custom providers — رمزنگاری‌شده، اول امتحان می‌شوند، failover خودکار. |

---

## گام ۸ — اتصال همهچیز به هم (نقشهٔ متغیرها)

هر کدام از این‌ها که به وضعیت شما مربوط است را در `.env` بگذارید و **هر دو
پروسه** را ری‌استارت کنید:

```bash
DATABASE_URL=file:./db/voxshift.db          # الزامی
VOXSHIFT_MODELS_DIR=/home/z/models          # فقط اگر پیش‌فرض نیست
VOXSHIFT_RAM_BUDGET_MB=4000                 # فقط برای override کردن تشخیص cgroup
VOXSHIFT_FISH_WEIGHTS=/path/to/weights      # فقط اگر خارج از چیدمان پیش‌فرض است
VOXSHIFT_F5_WEIGHTS=/path/to/weights        # "
VOXSHIFT_CHATTERBOX_WEIGHTS=/path/to/weights  # "
VOXSHIFT_CLONE_REF_TEXT="من علی هستم"       # متن مرجع سراسری (fallback)
VOXSHIFT_SATELLITE_CLONE_URL=http://host:3011  # کلون با ساتلایت
VOXSHIFT_WHISPER_MODEL=base                 # اختیاری: لهجه/انگلیسی-داخل-فارسی بهتر
ELEVENLABS_API_KEY=…                        # اختیاری: کلون ابری
```

هر جزء به چه چیزی وصل می‌شود، در یک خط:

- **مدل‌های vosk** → با نام دقیق پوشه زیر `$MODELS_DIR` پیدا می‌شوند →
  `local:vosk-asr` (فارسی اصلی · انگلیسی پشتیبان).
- **whisper** → `whisper-tiny-ct2` باندل‌شده + پکیج pip فاستر-ویسپر → ورکر
  ساکن (انگلیسی + تشخیص خودکار، دو-اجرایی با vosk، ادغام‌شده).
- **صداهای piper** → با نام دقیق فایل زیر `$MODELS_DIR/piper/` →
  `local:piper-tts` (fa_IR-amir / en_US-amy / en_US-ryan برای طنین مردانه).
- **fish/f5/chatterbox** → پکیج pip + چیدمان وزن‌های بالا → سطوح ۱ تا ۳
  زنجیرهٔ `local:voice-cloning`.
- **ساتلایت** → `VOXSHIFT_SATELLITE_CLONE_URL` → سطح ۴ زنجیره.
- **ElevenLabs** → `ELEVENLABS_API_KEY` → سطح ۵ زنجیره.
- **timbre/pitch-conformed DSP** → داخلی، بدون تنظیم → سطوح ۶ و ۷ (همیشه
  در دسترس؛ با برچسب صادقانه).

---

## گام ۹ — تأیید صحت کل زنجیره

```bash
# پروب‌های واقعی موتورها (سنتز از طریق خودِ ورکرها):
bun tests/probe-clone-chain.ts      # ماتریس گیت‌ها: پکیج ✓ وزن‌ها ✓ RAM ✓
bun tests/probe-clone-synth.ts      # سنتز واقعی fish/f5 از ابتدا تا انتها
bun tests/probe-timbre-conform.ts   # اندازه‌گیری عینی مورف timbre

# سوئیت یکپارچهٔ کامل خط لوله (ASR + ترجمه + TTS + روتر + تاریخچه):
bun tests/integration/run.ts
```

در خود برنامه: **About → Diagnostics → Run self-test** همهٔ مراحل خط لوله را
زنده اجرا می‌کند؛ بخش‌های *Engine chains* و *Voice cloning priority chain* در
صفحهٔ About وضعیت گیتِ هر سطح را با نشان **ACTIVE** روی موتورِ فعال نشان
می‌دهند. یک صدا ثبت کنید (Voice Identity → ~۱۵ ثانیه ضبط) و بعد **Test my
voice** بزنید — دقیقاً همان زنجیره‌ای اجرا می‌شود که خط لولهٔ بلادرنگ استفاده
می‌کند.

---

## گام ۱۰ — عیب‌یابی

| علامت | علت → راه‌حل |
| --- | --- |
| موتور کلون `unavailable — RAM` | پروبِ آگاه-از-cgroup می‌گوید حافظهٔ قابل‌استفاده از حداقل کمتر است (Fish 2600 / F5 2900 / Chatterbox 2600 مگابایت). پلن/حافظه را بالا ببرید، از **ساتلایت** استفاده کنید، یا سطح timbre-conformed را بپذیرید. `VOXSHIFT_RAM_BUDGET_MB` وقتی بهتر می‌دانید override می‌کند. |
| موتور کلون `unavailable — weights` | وزن‌ها در هیچ مسیرِ بررسی‌شده نیستند → چیدمان گام ۵ را چک کنید یا `VOXSHIFT_FISH_WEIGHTS` / `VOXSHIFT_F5_WEIGHTS` / `VOXSHIFT_CHATTERBOX_WEIGHTS` را ست کنید. |
| vosk / piper «runtime تشخیص داده نشد» | محیط پایتونی که مترجم استفاده می‌کند پکیج را ندارد. اجراکننده‌های ASR/TTS مسیرهای `PATH` → `/opt/voxshift/venv` → `/home/z/.venv` را بررسی می‌کنند (گام ۲)؛ **موتورهای کلون فقط `python3` ساده** — venvشان را قبل از استارتِ مترجم فعال کنید (یادداشت *کدام پایتون؟* در گام ۵). |
| دانلود صدای piper خطای 404 | از URLهای **`/resolve/v1.0.0/`** استفاده کنید (گام ۴) — `resolve/main` مرده است. |
| اولین جملهٔ انگلیسی کند است / timeout بوت whisper | `VOXSHIFT_WHISPER_MODEL=base` دفعهٔ اول از HF دانلود می‌شود (تایم‌اوت ۹۰ ثانیه) — برای هاست آفلاین همان `tiny` باندل‌شده بماند. |
| کلون شبیه صدای پیش‌فرض است، نه منِ خودم | پروفایل‌های قبل از v3.8 فایل WAV مرجع روی دیسک ندارند → **یک‌بار دوباره ثبت‌نام (re-enroll) کنید** تا مسیر timbre بتواند طنین شما را بازتولید کند. برای حالت clone حداقل ۸ ثانیه صدای تمیز لازم است. متنِ رونویسی مرجع را هم بدهید (`<profileId>.txt` در `db/audio/clone-ref/` یا `VOXSHIFT_CLONE_REF_TEXT`). |
| خطای `z-ai config not found` در self-test | برچسب صادقانهٔ UNCONFIGURED است، نه خطا — خط لوله با سطوح محلی + بدون‌کلید سرو می‌شود. اگر آن سطوح را می‌خواهید کلید ابری اضافه کنید. |
| خطای 429 از ElevenLabs | سهمیهٔ ارائه‌دهنده — روتر به‌صورت نمایی cooldown می‌کند و failover می‌شود؛ تلاش مجدد خودکار است. |
| متن فارسیِ به‌هم‌ریخته از صدای انگلیسی | از v3.6 به بعد نباید اتفاق بیفتد (تشخیص در لایهٔ ASR)؛ اگر در Settings زبان را روی `fa` قفل کرده باشید تشخیص خودکار دور زده می‌شود — بگذارید روی **Auto**. |

---

## یادداشت برای هاست Railway (کانتینر مرجع)

- cgroup کانتینر مرجع ~۹۵۴ مگابایت است؛ گیت‌های RAM آن را صادقانه می‌خوانند —
  پس موتورهای گیگابایتی کلون آنجا **عمداً** رد می‌شوند. سه راه کلون واقعی:
  ارتقای حافظه + `scripts/setup-local-clone.sh`، یا **ساتلایت** روی ماشین خودتان
  (`VOXSHIFT_SATELLITE_CLONE_URL`)، یا کلید ElevenLabs. سطح timbre-conformed
  همه‌جا بدون RAM اضافه کار می‌کند.
- اگر Railway دوباره deploy کند (REDEPLOY): استقرار مجدد باید این‌ها را شامل
  شود — `pip install faster-whisper` در venv، و در
  `mini-services/translator-service`: `bun add @prisma/client prisma@6.11.1` +
  `bunx prisma generate` (فایل `schema.prisma` همان‌جاست).
- فایل SQLite (و `db/.provider-secret`) را روی volume پایدار نگه دارید —
  ساختن دوبارهٔ secret کلیدهای ذخیره‌شدهٔ ارائه‌دهنده‌ها را بی‌اعتبار می‌کند
  (صادقانه `DECRYPT_FAILED` گزارش می‌شود، نه شکست خاموش).
