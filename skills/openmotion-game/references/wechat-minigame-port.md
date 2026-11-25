# Publish a game as a WeChat Mini Game

## Guiding the user, one step at a time

When the user asks to publish the game on WeChat (or chooses **Publish → WeChat Mini Game**), you guide them in this conversation. The panel on the right only shows the steps and where they are; it has no instructions or controls. The page itself shows two small controls under your messages when their step comes: **Choose the .key file** (step 3; the file goes straight to this computer, never into the chat or to you) and the preview QR code (step 6). So every instruction comes from you, one step per message.

### Rules

- **Read progress, never guess it.** Start with `openmotion_game_wechat` `action:"status"`. Every action returns the same status. Say a step is done only when that status says `done`; the panel ticks it from the same data. If you ask the user to do something and they say "done", call the matching action (check, confirm) before moving on.
- **One step per message.** Each message has: the step number and name, numbered exactly like the panel: main steps "step 4 of 8 · IP allowlist" (8 main steps), going-live steps "going live 2 of 4 · review" (never "of 12"), written in the user's language (in Chinese: 「第 4/8 步 · IP 白名单」「正式上线 2/4 · 提审」), where to go (with the link), what to click (numbered), what they get back, and one line on why. Then stop and wait.
- **Who does what.** Only the user, in the Mini Program console (mp.weixin.qq.com, the Mini Program console, not the Official Account console): register, copy the AppID, download the upload key, edit the IP allowlist, add testers, add the category, submit for review, file the Mini Program and release. You: read status, run checks, make the preview code, upload, port the game, and write the review copy. OpenDesign saves the key locally.
- **Never ask for, read or print the upload key.** If the user pastes key text into the chat, tell them it should not be in the conversation, do not repeat it, and ask them to use **Choose the .key file** under your message instead. The key stays in `~/.config/opendesign-wechat/`.
- **Quote WeChat, do not paraphrase results.** For checks, preview and upload, report what the tool returned (address, version, time, error text), then what to do next.

### The steps

1. **Account** (`account`). Registration page: https://mp.weixin.qq.com/wxopen/waregister?action=step1 . Choose Mini Program, then the **Games** category; category and account type cannot be changed later. When they say it is registered, call `confirm` `step:"account"`.
2. **AppID** (`appid`). Console → Management → Development management → Development settings → copy the AppID (starts with `wx`). When they paste it, call `set_appid`.
3. **Upload key** (`key`). Same page → Mini Program code upload → Generate (an administrator scans) → **Download the key before clicking Done**; WeChat allows only 3 a day. Then tell them to click **Choose the .key file** under this message. Check with `status` that `hasKey` is true. If a later check, preview or upload comes back with `keyRejected: true`, WeChat refused this key (wrong file, or a key for another AppID): say so, and tell them to download the key for this AppID again and click **Choose the .key file** under your message; the page shows it only in that case.
4. **IP allowlist** (`ip`). Call `ip_check` first. If allowed, say so and move on. If not, give the exact address from `result.ip`: same page → IP allowlist → Edit (administrator scans) → add that address on its own line, keep the existing ones, save. When they say it is added, call `ip_check` again. With a proxy or VPN the address differs from IP websites; the check uses the address WeChat itself sees.
5. **Port** (`port`). Port the game as below. Tell the user it takes a few minutes and that the web game does not change.
6. **Preview code** (`preview`). Call `preview`. Tell them the QR code is shown under this message, that only administrators, developers and testers can open it, and that it expires; others who scan see "no access".
7. **Upload** (`upload`). Propose `nextVersion` and a one-line description and ask them to confirm or change both, then call `upload`. Before that, the upload is not authorized: preview and build never imply upload.
   - `outcome:"done"`: say the version is now a development version that only they can open.
   - `outcome:"failed"`: give the error text and the fix (wrong key or AppID → download the key again for this AppID; `-10008` → step 4; version → use a higher number).
   - `outcome:"unknown"`: WeChat did not answer, so the version **may already be there**. Do not upload again yet. Ask them to open Version management → Development versions and look for that version and time. Then call `confirm_upload` with `present:true` or `false`. Upload again only after `present:false` (or with `confirmMissing:true` if they cannot check).
8. **Trial version and testers** (`testers`). Version management → Development versions → Set as trial version; Member management → Testers → Add each friend's WeChat ID; send them the trial QR code. Call `confirm` `step:"testers"`. Then say who can play now: their testers in WeChat, and anyone with the OpenDesign link as a web page. Ask whether they want everyone on WeChat to play; the next four steps are only for that.

Going live (only if they want every WeChat user to play):

9. **Service category** (`category`). Settings → Basic settings → Service category → Add → Games and the type that fits. Also check name, icon and description there. `confirm`.
10. **Review** (`review`). First write the review copy for them, from `status.game` and the game files, in their language, ready to paste: a one-line intro (≤ 30 characters), a short description of how to play, the version notes for this upload, and a content self-check (no login, no payment, no user-generated content, no external links, unless the game has them). Use only facts from this game; do not copy fixed templates. Then: Version management → Submit for review next to the trial version → fill in → submit. `confirm`.
11. **Filing** (`filing`). Only the account owner can do this: their own ID card and a face check in WeChat. Home page → Mini Program filing. It can run while the review runs. `confirm` when submitted.
12. **Release** (`release`). After both review and filing pass: Version management → Release. `confirm`. Then everyone on WeChat can find and play it.

For a later update, start at step 6 with the next version; category and filing are not repeated.

## Port a web game to a WeChat Mini Game

Use this when the user publishes an OpenMotion game to WeChat. The output is a Mini Game project the local service uploads with miniprogram-ci, so it must run without a browser DOM.

## Output

Write the project into the game, under `wechat-minigame/`, with `openmotion_game_write_files` (text files only):

- `wechat-minigame/game.js` — the whole game.
- `wechat-minigame/game.json` — `{"deviceOrientation":"portrait"}` (or `"landscape"` for a landscape game).
- `wechat-minigame/project.config.json` — `{"appid":"touristappid","compileType":"game","projectname":"<ascii-slug>","setting":{"es6":true,"minified":true}}`. The local service passes the real AppID at upload time.
- `wechat-minigame/mock-wx-test.js` — the node smoke test below. It is excluded from the upload.
- `wechat-minigame/port-report.json` — written only after the smoke test passes (see below).

Keep the main package under 4 MB. No network requests, no `eval` / `new Function`, no external resources.

## Rules

- **No DOM.** Draw everything on the main canvas from `wx.createCanvas()`: HUD, title, score, buttons, start/end panels and hints. Buttons are hit rectangles on the canvas.
- **Input:** `wx.onTouchStart` (and `wx.onTouchEnd` / `wx.onTouchMove` when the game needs them). Map keyboard controls to on-canvas touch controls.
- **Size:** `wx.getSystemInfoSync()` windowWidth / windowHeight and pixelRatio; scale the canvas by pixelRatio.
- **Safe area:** read `wx.getMenuButtonBoundingClientRect()` and keep the HUD below the capsule button in the top-right corner.
- **Storage:** `wx.getStorageSync` / `wx.setStorageSync` for best score and settings (same keys as the web game).
- **Audio:** `wx.createWebAudioContext()` when available; stay silent when it is not.
- **Images:** `wx.createImage()`; inline images become files under `wechat-minigame/images/` only when they are small; otherwise draw them in code.
- **Same game:** keep rules, numbers, colors, copy and win/lose/restart exactly as in the web game.
- **Errors:** catch errors in the main loop and draw 「哎呀，出错了，请重启试试吧~」 instead of a blank screen.

## Smoke test (required)

`wechat-minigame/mock-wx-test.js` builds a minimal `wx` stub in node (a fake 2D context that records calls, touch handlers you can trigger, an in-memory storage), loads `game.js`, simulates start and three taps, and asserts: no exception, the score or state changed, storage was written. Run it with `node wechat-minigame/mock-wx-test.js` through the tools available to you; the port is done only when it passes.

When it passes, write `wechat-minigame/port-report.json` last: `{"smokeTest":"passed","runId":"<run id from the request, if given>","output":"<the test's last output line>","files":[{"path":"game.js","bytes":12345}]}`. The publish status reads this file; never write it before the test passes. It is excluded from the upload.

Writing files marks the game as `building`, which hides the web game behind "Agent is running". The port does not change the web game, so after `port-report.json` is written call `openmotion_game_set_status` with `status:"ready"` (only if the game was ready or published before the port). Never call it with `building` for a port.

## Report

End with three short lines: the files and their sizes, the smoke-test output, and what still needs a real device (touch feel, audio, safe area on notched phones).

The reference port of 「叠月亮」 followed exactly these rules.
