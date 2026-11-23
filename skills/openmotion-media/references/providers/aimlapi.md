# AI/ML API BYOK

Checked against the official documentation and live catalogue on 2026-11-18. Sections: discovery, request templates, polling, errors, sources.

## Setup and discovery

Save the key in editor **Model providers**. `AIMLAPI_API_KEY` is the environment alternative; the saved key wins. The service injects `Authorization: Bearer ...`. One key covers image, video, music and speech. Agents discover with `openmotion_media_use` and generate with `openmotion_assets_use`; never read credential files or put keys in arguments.

```json
{"action":"models","provider":"aimlapi","refresh":true,"modality":"video","query":"seedance","limit":20}
```

Discovery reads the public catalogue `GET https://api.aimlapi.com/v1/models?include=modalities` and classifies each row by its `type` field only:

| Catalogue `type` | Modality / mode |
| --- | --- |
| `openai/image-generations` | image, `text-to-image` (an ID that names `image-to-image` keeps that mode) |
| `internal/video-generations/submit` | video, `text-to-video` (an ID that names `image-to-video` keeps that mode) |
| `internal/audio-generations/submit` | audio, `text-to-audio` (music) |
| `internal/text-to-speech` | audio, `text-to-speech` |

Rows without `text` input, and chat, transcription, embedding, editing and realtime rows, are not listed. Without a configured key, a general catalogue refresh does not contact AI/ML API; request `provider: "aimlapi"` explicitly to preview it. The tool returns normalized metadata, not every model's input schema; each model's documentation is linked from the [complete model list](https://docs.aimlapi.com/api-references/service-endpoints/complete-model-list). Public discovery and built-in examples do not establish key validity, balance or model entitlement.

## Request templates

These JSON objects are `openmotion_assets_use` arguments. Assign a unique requestId per intended generation. Verify current availability and schema first; generation can incur charges.

Image — [FLUX Schnell](https://docs.aimlapi.com/api-references/image-models/flux/flux-schnell):

```json
{"action":"generate","requestId":"aimlapi-image-01","model":"aimlapi:flux/schnell","modality":"image","mode":"text-to-image","prompt":"A ceramic cup on a wooden table, soft morning light","parameters":{"image_size":"landscape_16_9"}}
```

Video — [Seedance 1.0 Pro Fast](https://docs.aimlapi.com/api-references/video-models/bytedance/seedance-1.0-pro-fast):

```json
{"action":"generate","requestId":"aimlapi-video-01","model":"aimlapi:bytedance/seedance-1-0-pro-fast","modality":"video","mode":"text-to-video","prompt":"Steam rises from a ceramic cup as the camera slowly moves closer","parameters":{"resolution":"720p","duration":5}}
```

Music — [Stable Audio](https://docs.aimlapi.com/api-references/music-models/stability-ai/stable-audio):

```json
{"action":"generate","requestId":"aimlapi-music-01","model":"aimlapi:stable-audio","modality":"audio","mode":"text-to-audio","prompt":"A gentle instrumental piano loop for a quiet morning","parameters":{"seconds_total":20}}
```

Speech — [OpenAI TTS-1](https://docs.aimlapi.com/api-references/speech-models/text-to-speech/openai/tts-1):

```json
{"action":"generate","requestId":"aimlapi-speech-01","model":"aimlapi:openai/tts-1","modality":"audio","mode":"text-to-speech","prompt":"Welcome to a quiet morning.","parameters":{"voice":"alloy"}}
```

Other speech models use their own voice names; read the selected model's schema. Wire mapping (paths relative to `https://api.aimlapi.com`):

| Modality | Request | JSON body | Result |
| --- | --- | --- | --- |
| Image | `POST /v1/images/generations` | `{model,prompt,...parameters}` | `data[].url` or `data[].b64_json` |
| Video | `POST /v2/video/generations` | `{model,prompt,...parameters}` | task `{id,status}` |
| Music (`text-to-audio`) | `POST /v2/generate/audio` | `{model,prompt,...parameters}` | task `{id,status}` |
| Speech (`text-to-speech`) | `POST /v1/tts` | `{model,text,...parameters}` | `audio.url` in JSON, or audio bytes |

Reference-media URLs (for example `image_url` on image-to-video models) belong in provider-native parameters. This tool does not upload local paths.

## Polling and result

Video and music return a task. The adapter keeps its `id` as the job's remote ID and polls that same task: `GET /v2/video/generations?generation_id={id}` or `GET /v2/generate/audio?generation_id={id}`. `queued` and `generating` continue; `completed` imports `video.url` (object or list) or `audio_file.url`; `error` ends local processing. A failed status read is retried; the paid submission is never resent. Agent polling uses the local ID, not the remote task ID:

```json
{"action":"status","jobId":"LOCAL_JOB_ID_FROM_GENERATE"}
```

Returned file links redirect to public HTTPS storage and are downloaded without credentials. Local cancellation or timeout does not prove a remote stop and does not promise a refund. Query the original job before creating another billable task.

## Error interpretation

| Signal | Actual possible meaning / next action |
| --- | --- |
| HTTP 400 / 422 | Invalid body for the selected model: a missing required field, a value outside its enum or a prompt length limit. Compare the parameters with that model's schema. |
| HTTP 401 / 403 | Missing, unknown or revoked key, or a key without access to the model. OpenMotion marks the saved key rejected; replace it in **Model providers**. |
| HTTP 402 / balance message | Insufficient balance. Top up in the AI/ML API console; retrying unchanged cannot fix it. |
| HTTP 404 | Unknown model ID or expired task ID. Re-run discovery; do not resubmit before checking the original job. |
| HTTP 429 | Rate limit. Reduce concurrency and back off. |
| HTTP 5xx / timeout | Service or upstream failure. The outcome of a submission can be unknown and still billed; inspect the original job before any new POST. |
| Task `status: error` | The upstream model rejected or failed the task (moderation, invalid input). Review the prompt and parameters. |

Current OpenMotion non-2xx handling omits the raw provider error body/headers. Its `credentials or permissions rejected` suffix is synthesized locally. When a detail is unavailable, state that the exact cause is unknown.

## Sources

- [Key creation](https://aimlapi.com/app/keys), [quickstart](https://docs.aimlapi.com/quickstart/setting-up)
- [Complete model list](https://docs.aimlapi.com/api-references/service-endpoints/complete-model-list), [image models](https://docs.aimlapi.com/api-references/image-models), [video models](https://docs.aimlapi.com/api-references/video-models), [music models](https://docs.aimlapi.com/api-references/music-models), [speech models](https://docs.aimlapi.com/api-references/speech-models)

## Shared parameter discovery

Checked on 2026-11-18 against each model's schema (`https://api.aimlapi.com/docs-json?model=...`): model discovery exposes `generationOptions` for FLUX Schnell (`image_size`, `num_images` 1–4, `seed`), Seedance 1.0 Pro Fast (`resolution` 480p/720p/1080p, `duration` 5 or 10, `camerafixed`, `seed`), Stable Audio (`seconds_total` 1–47, `steps`) and OpenAI TTS-1 (`voice`, `speed`). Unknown catalogue models keep their provider-specific parameters without an inferred control profile.
