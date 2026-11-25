> Written for OpenMotion; see [source and execution notes](../PROVENANCE.md).

# Feel, Visual Readability, Input Hygiene, and Audio Craft

Load on demand when polishing 2D/3D combat feel, lighting readability, layered UI, or input stability. Every pattern below executes cleanly inside OpenMotion's zero-CDN local bundle and deterministic `logic.js` VM.

## 1. Proportional Feedback & Per-Actor Hit-Stop

Drive juice from discrete state events (`hit`, `parry`, `clear`, `dodge`, `down`, `boss_break`) through one `feedback(tier, pos)` helper so minor taps never overpower critical moments:

| Tier | Camera Trauma | Hit-Stop | Particles | Audio & Extra | Typical Events |
|---|:---:|:---:|:---:|---|---|
| **Small** | `0.08–0.18` | None | `0–4` | Crisp transient tick | Tile select, card hover/draw, light step |
| **Medium** | `0.25–0.45` | `45–70 ms` | `6–12` | Flash + directional sparks + pitch-stepped SFX | Parry, combo clear, normal hit, nitro burst |
| **Heavy** | `0.55–0.85` | `80–120 ms` | `14–24` | Radial pulse + brief slow-mo / recoil | Boss break, perfect dodge counter, wave clear, crash |

- **Per-actor hit-stop (never global sludge):** Freeze only the attacker and victim briefly (`45–110 ms`) with micro-jitter on the victim while surrounding motion continues. Keep camera shake decay and UI tweens on real time, and expose key feel constants (hit-stop, shake/recoil, particle burst, audio gain) in `config` so players can calibrate them in one tweak.
- **Buffer inputs during hit-stop:** Queue the next tap, attack, parry, or dodge during freeze frames so rapid inputs are never dropped. Dodge/evade interrupts regular attacks.
- **Audio priority & ducking:** Build layered WebAudio sounds (filtered noise + resonant decay + sharp transient) in `AudioBuffer` rather than harsh raw square beeps. Rate-limit simultaneous hit sounds and duck background ambience/ordinary hit gain (`-3` to `-6 dB`) whenever Boss telegraphs or critical cues fire.

## 2. Combat Reach, Telegraphs, and Lighting Readability

- **Top-down / isometric 3D melee clarity:** Pair swings with bounded attack magnetism — select the nearest target weighted by distance and facing angle, and clamp lunge step to `min(step, dist - standOffset)` so attacks never overshoot. Keep soft body separation between living actors so characters do not stack into one mesh.
- **Telegraphs & hazard hue separation:** Render danger zones (Boss slams, lane lasers, incoming sweeps) with animated progress fills, contracting rings, or directional stripes — never an opaque flat circle that obscures actors. Always separate interactive target rings/zones and incoming hazards by distinct hues (never same-color bolt on same-color timing ring).
- **Lighting & exposure discipline (Three.js / 2D):** Set deliberate tone mapping and exposure; tag albedo/emissive maps as sRGB and roughness/normal masks as non-color. Establish unmistakable luminance separation between **ground < obstacles < heroes & focal objectives** so scenes never turn muddy dark on phones or white-out under bloom (cap emissive/bloom peaks at `2–3`).
- **Procedural surface variation:** When building zero-paid-asset 3D scenes, vary material roughness, grime, or wetness across zones (e.g. dry deck vs damp track vs glowing accent trim) instead of uniform plastic surfaces, and spend detail budget on the focal playfield and silhouette landmarks.

## 3. Input Hygiene & Responsive HUD Safety

- **Bulletproof keyboard state:** On pressing a directional key, clear its opposing direction from the held set. Clear held keys on `window` `blur`, `visibilitychange`, and `Meta`/`Alt`/`Control` modifier changes — **never** include `Shift` (often bound to dash/boost/drift). Never infer key-up from missing key-repeat events; sync mouse buttons via `event.buttons` on move.
- **Anchor-based, non-truncating HUD & callout contrast:** Layout HUD with edge/corner anchors and safe-area insets, never fixed pixel coordinates. Keep top-bar titles and status chips short (`max-width`, clean flex wrap or compact icon+value) so headers never clip mid-word at `390×844` portrait, and back transient center callouts (countdowns, Boss warnings, danger banners) with a clean dark scrim or contrasting stroke so they stay readable over bright 3D props/signage.
- **Max-density portrait verification:** Always inspect `390×844` under worst-case HUD density (full hand of 6–7 cards, 6/7 tray slots + expanded temp slots, or active mobile joystick + skill buttons) — never only on an empty opening frame.
- **Figure-ground & occlusion clarity (`discrete-ui`):** Keep interactive cards and clickable tiles markedly brighter/higher-contrast than the dark table surface, and dim/desaturate covered layers by `35–45%` with a subtle hatch and clear staggered edge peek (`≥ 25–35%`) so underlying symbols stay scannable for look-ahead planning. Never paint covered items solid opaque black or bury card copy on muddy low-contrast dark fills.
