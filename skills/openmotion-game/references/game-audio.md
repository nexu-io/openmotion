> See [source and execution notes](../PROVENANCE.md).

# Game Audio

Use this reference for music, voice, SFX and ambience. A game that is silent or only beeps when the brief asks for mood, story or characters is below the quality floor. Generate music and spoken lines through OpenMotion media when a fitting model is listed; synthesize short SFX with the Web Audio API in game code. Normalize and mix in code for predictable in-game loudness.

## Discover the live contracts

Follow the `openmotion-media` provider order and consent rules (`openmotion://workflow/media/start`). Before the first audio job:

```json
{"tool":"openmotion_media_use","arguments":{"action":"inspect"}}
```

```json
{"tool":"openmotion_media_use","arguments":{"action":"models","provider":"account","modality":"audio","refresh":true}}
```

Use provider `opendesign` when the account is unavailable, then any other configured provider. Read `action:"reference"` for the chosen provider before mapping parameters. Audio entries carry `mode:"text-to-speech"` (voice) or `mode:"text-to-audio"` (music); use the discovered mode, never the vendor name, to decide what a model makes. Built-in entries (`source:"builtin"`) are discoverable but do not prove plan entitlement; only a completed job does.

## Routing

Select models from live discovery (`openmotion_capability_discover` or `openmotion_media_use`) using `mode`, `bestFor`, `description`, and `generationOptions` (following `account` → `opendesign` → other configured providers):

| Need | Discovery / capability routing rule (OpenDesign first) | Notes |
|---|---|---|
| Background music, menu loop, boss theme | `music` capability or audio model with `mode:"text-to-audio"` (`bestFor` matching `bgm-loop` / `soundtrack`) | Prompt instrumental with `no vocals`. Pass length using the provider-native option from `action:"reference"` / `generationOptions` (e.g. `music_length_ms` on Cloud, whole-second `duration` on account). |
| Character lines, narration, announcer (English and multilingual) | `speech` capability or audio model with `mode:"text-to-speech"` (`bestFor` / `description` matching `multilingual-speech` / `en-speech`) | Pick `parameters.voice` from the model's live `generationOptions` voices. |
| Chinese character lines and narration | `speech` capability or audio model with `mode:"text-to-speech"` (`bestFor` / `description` matching `zh-speech`) | Pick a listed Chinese voice from the model's live `generationOptions`. |
| Short SFX (hit, jump, coin, UI click, explosion) | Check live `audio` discovery for a dedicated SFX model (`bestFor` matching `sfx`); otherwise Web Audio synthesis below | Use a discovered SFX model through the same consent flow when listed. |
| Ambience bed | Discovered `mode:"text-to-audio"` music model as a soft instrumental pad, or Web Audio noise layers | Keep under music level. |

Never use a model name that discovery did not return. No dedicated SFX model is a capability gap, not an error: synthesize instead of searching for unlisted names.

## Requests

Submit only after the user approved the planned list. Each new intended job needs a unique `requestId`.

When Unified Capability Center meta-tools are exposed (and discovery reports `music` / `speech` with `status:"live"` and `available:true`), submit via **`openmotion_capability_run`**:

Music (`openmotion_capability_run`):

```json
{"action":"run","requestId":"game-bgm-01","capabilityId":"music","model":"<provider>:<discovered-music-model>","prompt":"Instrumental synthwave racing loop, 128 BPM, driving bass, bright arpeggios, no vocals, seamless loop ending","parameters":{}}
```

Speech (`openmotion_capability_run`):

```json
{"action":"run","requestId":"game-vo-hero-01","capabilityId":"speech","model":"<provider>:<discovered-speech-model>","prompt":"The gate is open. Move!","parameters":{"voice":"<voice id listed by models>"}}
```

When using **`openmotion_assets_use`** directly (fallback or legacy hosts), use its `action:"generate"` schema:

Music (`openmotion_assets_use`):

```json
{"action":"generate","requestId":"game-bgm-01","model":"<provider>:<discovered-music-model>","modality":"audio","mode":"text-to-audio","prompt":"Instrumental synthwave racing loop, 128 BPM, driving bass, bright arpeggios, no vocals, seamless loop ending","parameters":{}}
```

Speech (`openmotion_assets_use`):

```json
{"action":"generate","requestId":"game-vo-hero-01","model":"<provider>:<discovered-speech-model>","modality":"audio","mode":"text-to-speech","prompt":"The gate is open. Move!","parameters":{"voice":"<voice id listed by models>"}}
```

Poll the returned `job.id` with `openmotion_job_manage` or `openmotion_assets_use` (`{"action":"status","jobId":"<job.id>"}`) until `state:"completed"`, read the saved `{assetId, versionId}` from `job.libraryAssets[]`, and call `openmotion_asset_manage` / `openmotion_assets_use` (`{"action":"read","assetId":"...","versionId":"..."}` or `action:"get"`) to inspect `version` metadata (duration, format, mimeType). Speech results may include timing metadata (ElevenLabs `alignment`, BytePlus `sentences`) in `job.result`; use it to sync subtitles or mouth flaps. Never auto-retry a failed paid job; follow the media job procedure.

## Wiring generated audio

Reference completed audio by its library URL; no binary copy into the game is needed:

```js
const ctx = new AudioContext();
async function loadClip(url) {
  const res = await fetch(url);
  return ctx.decodeAudioData(await res.arrayBuffer());
}
const bgm = await loadClip('/motion-api/assets/<assetId>/versions/<versionId>/media');
```

Playtest, cover capture and trailer recording serve these URLs from the same local service; `openmotion_assets_use action=web_publish` rewrites them to bundled relative paths. Record asset id, version id, model, license and approved cost in `design/assets.csv`. Handle load failure by continuing silently with synthesized fallbacks, never by blocking play.

## Web Audio SFX synthesis

Build a tiny sound kit in `client.js` with oscillators, noise buffers and envelopes. Every SFX is a function that schedules nodes on the shared context:

```js
function blip(freq = 660, dur = 0.08, type = 'square', gain = 0.25) {
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(freq * 1.6, t + dur);
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(sfxBus); o.start(t); o.stop(t + dur);
}
```

Recipes: pickup = rising square blip; jump = short sine sweep up; hit = 40–80 ms filtered noise burst plus low sine thump; explosion = 0.4 s low-passed noise with falling cutoff; UI click = 15 ms triangle tick; engine = sawtooth with frequency mapped to speed through a low-pass filter. Vary pitch ±5% per play so repeats do not fatigue.

## Scope

- Music: at most two looping tracks for a small game; one per major scene is usually enough.
- SFX: prioritize the primary verb, damage/feedback, pickup/reward, important environment, then one ambience layer. Keep small games to roughly five essential effects.
- Voice: lock one voice per speaking entity and reuse it. Keep lines short enough not to block gameplay; always show subtitles.
- Submit independent approved clips together, but wait for every job and wire only completed versions.

## Prompt rules

- Music prompts specify mood, tempo, instrumentation and `instrumental, no vocals` when lyrics are unwanted; ask for a clean loop ending.
- Voice prompts contain the exact line only; choose tone through `parameters.voice` (OpenDesign `account` speech currently accepts `parameters.voice` only; OpenDesign Cloud `opendesign` also exposes provider-native options such as `voice_settings` and `audio_params.speech_rate` when listed by discovery), never undocumented flags.
- Preserve the game's STYLE FORMULA conceptually through material, era, energy and tonal language.

## Mix and ear safety

Route through `musicBus`, `sfxBus` and `voiceBus` gain nodes into one master compressor:

- Voice around -6 dBFS.
- SFX around -10 to -12 dBFS.
- Music around -18 to -20 dBFS; duck by ~6 dB under voice.
- Final true peak at or below -3 dBFS.

Voice stays above SFX; SFX stays above music. Loop music with `AudioBufferSourceNode.loop` and short fades at boundaries. Never stack raw model outputs at full gain.

## Verification

- Every audio URL in `design/assets.csv` loads without a 404 in playtest's failed-request list.
- Autoplay restrictions are handled: create or resume the audio context from a user gesture.
- A mute toggle exists; audio pauses when the page loses focus if that matches the game profile.
- The game remains playable with sound disabled.
- Headless playtest does not establish audible quality; report it as unverified.
