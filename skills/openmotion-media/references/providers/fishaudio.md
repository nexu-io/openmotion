# Fish Audio speech and saved voices

Checked against the official API documentation on 2026-11-17.
Configure **Fish Audio** in Settings → Model providers, or set `FISH_API_KEY` for this runtime. The fixed origin is `https://api.fish.audio`; authentication is Bearer API key. Credentials stay service-owned. Only speech is implemented. The maintained model example is `fishaudio:s2-pro`; model listing uses documented local entries, not an invented live model catalogue. Listing account voice models is a separate capability.

Use `openmotion_assets_use` with `action=voice` and `voice.command=list|get|add|update|check|discover`. `discover` accepts `provider=fishaudio` and a 1-based page. It reads `GET /model?self=true&page_size=100&page_number=N` and returns `nextPage`; follow pages before concluding a voice is missing. `check` reads the first page only; `not_listed` is inconclusive. Saving a record never clones, activates, generates or deletes a remote voice. UI and MCP use the same workspace records.

```json
{"action":"voice","voice":{"command":"add","requestId":"save-narrator-1","provider":"fishaudio","externalId":"YOUR_VOICE_MODEL_ID","name":"My narrator","kind":"unknown"}}
```

Read the returned local voice ID and revision; use them in the next request:

```json
{"action":"generate","requestId":"narration-1","modality":"audio","mode":"text-to-speech","model":"fishaudio:s2-pro","prompt":"Your script.","voiceRef":{"voiceId":"LOCAL_VOICE_UUID","revision":1}}
```

The adapter maps the saved voice ID to `reference_id`, script to `text`, speed to `prosody.speed`, requests MP3 and selects the synthesis model via the `model` header at `POST /v1/tts`. Without a saved reference, native parameters accept `voice` and `speed`. Conflicting voice parameters are rejected when a voiceRef is present. Speech is synchronous; there is no remote polling or confirmed remote cancellation. HTTP errors stop the task; no paid POST is automatically retried. Local cancellation does not prove a provider refund or remote stop.

Poll the original local job, read its saved audio version and import that version into the intended project. The audio version records the voice configuration; that does not pin remote model weights. Recheck a saved voice after changing its connection. An attached local audio sample is not a successful synthesis test. Existing voices only: in-app cloning/design and persistence of design candidates are outside this implementation.

Official references: [TTS](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech), [voice model list](https://docs.fish.audio/api-reference/endpoint/model/list-models), [key setup](https://docs.fish.audio/api-reference/introduction).

## Regions

The official [Chinese developer page](https://fish.audio/zh-CN/developers/) also uses `https://api.fish.audio/v1/tts` (checked 2026-11-17). No separate public regional API contract was found, so Settings keeps a single Fish Audio connection. Interface language and enterprise self-hosting do not imply a second regional API preset.

Voice management updates and checks use exact revision guards. Speech references retain the immutable saved voice identity across metadata edits and rechecks; queued jobs preserve their original source snapshot. Trash, unavailable/changed connections and a mismatched remote voice identity still prevent submission. Native speech without a saved selection or explicit/default voice ID is rejected before queueing.
