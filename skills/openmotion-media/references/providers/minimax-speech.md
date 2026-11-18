# MiniMax Speech and saved voices

Checked against the official API documentation on 2026-11-17.
Configure **MiniMax Speech** in Settings → Model providers, then choose **China mainland** or **International**. Each region is an independent connection with its own key, models and saved voices. Both use Bearer authentication and the documented `speech-2.8-hd` and `speech-2.8-turbo` model entries; these are examples, not account entitlement or live discovery evidence.

| Region | Provider ID | API origin | Environment key |
| --- | --- | --- | --- |
| China mainland | `minimax-speech-cn` | `https://api.minimax.cn` | `MINIMAX_SPEECH_CN_API_KEY` |
| International | `minimax-speech` | `https://api.minimax.io` | `MINIMAX_SPEECH_API_KEY` |

Existing international IDs, keys and saved voices remain unchanged. Select the matching provider when saving/discovering voices and prefix the model with that provider ID, for example `minimax-speech-cn:speech-2.8-hd`. No keys or private voices are copied between regions or from language-model connections. Cross-region voice/model combinations are rejected.

`openmotion_assets_use` supports `action=voice` with commands `list|get|add|update|check|discover`. Discover uses `POST /v1/get_voice` with `voice_type=all` and normalizes system, cloned and designed voices. The provider lists custom voices only after successful synthesis; `not_listed` does not mean deleted. Cloned voices unused within seven days may be deleted upstream. No background activation or paid keep-alive runs.

```json
{"action":"voice","voice":{"command":"add","requestId":"save-minimax-1","provider":"minimax-speech","externalId":"YOUR_VOICE_ID","name":"My narrator","kind":"unknown"}}
```

Use the returned local ID and current revision:

```json
{"action":"generate","requestId":"minimax-narration-1","modality":"audio","mode":"text-to-speech","model":"minimax-speech:speech-2.8-hd","prompt":"Your script.","voiceRef":{"voiceId":"LOCAL_VOICE_UUID","revision":1}}
```

The wire call is `POST /v1/t2a_v2`: `model`, `text`, `voice_setting.voice_id`, `voice_setting.speed`, `stream=false`, `output_format=hex`, `audio_setting.format=mp3`. Scripts are limited to 10000 characters. Native `voice_setting` and `audio_setting` fields are retained; an explicit normalized `speed` overrides native speed. A different native voice ID conflicts with a selected saved voice. Synchronous requests share the 15-minute audio-job deadline, and hex JSON responses use the media response size limit (256 MB). Only a successful `base_resp.status_code=0` with valid hex audio is accepted; HTTP and envelope errors are distinct. There is no automatic paid POST retry, native polling or confirmed remote cancellation. Unknown outcome requires inspection of the original local task/provider history before a user explicitly requests another generation.

Saving a voice only saves local metadata. Updating/trashing/restoring affects local records, not the remote voice. Connection changes require a new check; no voice or provider is substituted. Audio outputs retain voice provenance and remain usable after removing the local voice. Use existing import/history protection to bring a selected audio version into a project. In-app clone/design and remote deletion are outside this implementation.

Official references: [TTS](https://platform.minimax.io/docs/api-reference/speech-t2a-http), [voice management](https://platform.minimax.io/docs/api-reference/voice-management-get), [clone lifecycle](https://platform.minimax.io/docs/api-reference/voice-cloning-clone).

China mainland references: [TTS](https://platform.minimax.cn/docs/api-reference/speech-t2a-http), [voice management](https://platform.minimax.cn/docs/api-reference/voice-management-get).

Voice management updates and checks use exact revision guards. Speech references retain the immutable saved voice identity across metadata edits and rechecks; queued jobs preserve their original source snapshot. Trash, unavailable/changed connections and a mismatched remote voice identity still prevent submission. Native speech without a saved selection or explicit/default voice ID is rejected before queueing.
