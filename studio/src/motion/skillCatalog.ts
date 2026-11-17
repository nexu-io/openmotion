/**
 * Skills shown on the Skills page, grouped by the video the user wants to make.
 * Scenario skills (promos, explainers, covers…) come first; open-source motion
 * libraries are kept as techniques. Open-source entries link to their upstream
 * repository. OpenMotion only borrows the workflow or technique: the Agent builds
 * an editable native project through MCP.
 */
import skillPrompts from './skill-prompts.json';
// Recorded official demos (three-js, lume, proton) and OpenMotion-made samples for skills without upstream video.
import olaVideo from './skill-covers/ola.mp4?url';
import olaPoster from './skill-covers/ola.jpg?url';
import threeJsVideo from './skill-covers/three-js.mp4?url';
import threeJsPoster from './skill-covers/three-js.jpg?url';
import lumeVideo from './skill-covers/lume.mp4?url';
import lumePoster from './skill-covers/lume.jpg?url';
import motionCanvasVideo from './skill-covers/motion-canvas.mp4?url';
import motionCanvasPoster from './skill-covers/motion-canvas.jpg?url';
import shiftyVideo from './skill-covers/shifty.mp4?url';
import shiftyPoster from './skill-covers/shifty.jpg?url';
import twoJsVideo from './skill-covers/two-js.mp4?url';
import twoJsPoster from './skill-covers/two-js.jpg?url';
import tweenJsVideo from './skill-covers/tween-js.mp4?url';
import tweenJsPoster from './skill-covers/tween-js.jpg?url';
import gifencVideo from './skill-covers/gifenc.mp4?url';
import gifencPoster from './skill-covers/gifenc.jpg?url';
import konvaVideo from './skill-covers/konva.mp4?url';
import konvaPoster from './skill-covers/konva.jpg?url';
import blenderVideo from './skill-covers/blender.mp4?url';
import blenderPoster from './skill-covers/blender.jpg?url';
import protonVideo from './skill-covers/proton.mp4?url';
import protonPoster from './skill-covers/proton.jpg?url';
import babylonJsVideo from './skill-covers/babylon-js.mp4?url';
import babylonJsPoster from './skill-covers/babylon-js.jpg?url';
export type SkillMotif = 'agent' | 'scene' | 'layout' | 'curve' | 'stagger' | 'math' | 'vector' | 'playback' | 'depth' | 'frames' | 'canvas' | 'particles'
  | 'icon' | 'sequence' | 'character' | 'globe' | 'levelup' | 'orbit' | 'promo'
  | 'photo' | 'polish' | 'listing' | 'narration' | 'brand' | 'thumbnail';
export type SkillCategory = 'Product promos' | 'Explainers' | 'Brand & covers' | 'Motion techniques';

export type MotionSkill = {
  id: string;
  /** Short task name shown as the card title, like "Product promo"; translated. */
  title: string;
  /** Upstream project name, kept verbatim. */
  name: string;
  /** Short English tagline; translated through the UI dictionary. */
  tagline: string;
  /** When to reach for this skill, in plain words; shown first on cards. */
  useWhen: string;
  /** The concrete deliverable, shown on cards and sent to the Agent. */
  output: string;
  category: SkillCategory;
  motif: SkillMotif;
  /** Upstream repository; absent for skills authored by OpenMotion. */
  repository?: string;
  license: string;
  /** Real upstream demo media (hotlinked from the source); the card falls back to an illustration. */
  /** compare: the media is a side-by-side before/after, shown whole (not cropped) with labelled halves. */
  cover?: { video?: string; gif?: string; poster?: string; aspect?: number; compare?: boolean; source: string };
  /** The workflow needs generated images, video or audio from configured providers. */
  media?: boolean;
  /** What the Agent should borrow from the upstream project. */
  technique: string;
  /** Example brief shown as the subject placeholder. */
  example: string;
};

export const skillCategories: SkillCategory[] = ['Product promos', 'Explainers', 'Brand & covers', 'Motion techniques'];

export const motionSkills: MotionSkill[] = [
  { id: 'motionmaxxing', title: 'Remove the AI look from motion', useWhen: 'When a motion video looks templated or AI-made and you want it to feel designer-made', name: 'motionmaxxing', output: 'A motion film that reads as designer-made: no slide layouts, color wipes, fake glow or invented numbers', tagline: 'Make AI motion look designer-made.', category: 'Motion techniques', motif: 'polish', repository: 'https://github.com/Tejashmakwana/motionmaxxing', license: 'Apache-2.0', cover: { video: 'https://raw.githubusercontent.com/Tejashmakwana/motionmaxxing/main/docs/media/spotify-comparison.mp4', poster: 'https://raw.githubusercontent.com/Tejashmakwana/motionmaxxing/main/docs/media/spotify-poster.jpg', aspect: 1.78, compare: true, source: 'https://github.com/Tejashmakwana/motionmaxxing#readme' },
    technique: 'Run its anti-slop review: before building, check the plan against its “never ship” list (slide-style title-left/card-right layouts, color-block wipes between sections, near-black backgrounds with radial glow, badges and counters, invented numbers, web-footer endings). After rendering, sample frames and fix the three biggest failures, at most two passes. Report what you checked; never certify the film yourself.', example: 'Rework my product launch video so it no longer looks AI-made' },
  { id: 'gifenc', title: 'Looping GIF sticker', useWhen: 'When the result should loop as a GIF, like a sticker or emoji', name: 'gifenc', output: 'A short seamless loop that also works as an animated GIF sticker', tagline: 'Animated GIF encoding.', category: 'Motion techniques', motif: 'frames', repository: 'https://github.com/mattdesl/gifenc', license: 'MIT', cover: { video: gifencVideo, poster: gifencPoster, aspect: 1.78, source: 'OpenMotion sample' },
    technique: 'Design a short seamless loop with a limited palette that also works as an animated GIF.', example: 'A 3-second looping sticker for social media' },
  { id: 'higgsfield-product-photoshoot', title: 'Product showcase reel', useWhen: 'When you have a product and need studio, lifestyle and banner shots in one reel', name: 'Product Photoshoot', output: 'A short product reel: studio shot, lifestyle shot and hero banner of your product', tagline: 'Studio and lifestyle product shots.', category: 'Product promos', motif: 'photo', repository: 'https://github.com/higgsfield-ai/skills/tree/main/higgsfield-product-photoshoot', license: 'MIT', cover: { video: 'https://static.higgsfield.ai/public/marketing-studio/hero-banners/marketing-studio-slider-poster-Product.mp4', aspect: 1.78, source: 'https://higgsfield.ai/marketing-studio' }, media: true,
    technique: 'Follow its product-photoshoot modes (studio, lifestyle, hero banner, floating/splash, seasonal variation) to generate product stills, then animate them into a short product reel with camera moves and captions.', example: 'A 10-second reel of my headphones: studio shot, lifestyle shot, hero banner' },
  { id: 'higgsfield-marketplace-cards', title: 'Listing video', useWhen: 'When listing a product on Amazon, Taobao or another store', name: 'Marketplace Cards', output: 'An e-commerce listing video: main image, selling points, specs and comparison cards', tagline: 'Listing images and A+ modules.', category: 'Product promos', motif: 'listing', repository: 'https://github.com/higgsfield-ai/skills/tree/main/higgsfield-marketplace-cards', license: 'MIT', cover: { video: 'https://static.higgsfield.ai/public/marketing-studio/hero-banners/marketing-studio-slider-poster-Marketplace.mp4', aspect: 1.78, source: 'https://higgsfield.ai/marketing-studio' }, media: true,
    technique: 'Follow its marketplace listing structure: a clean main image, secondary feature images and A+ style modules (benefits, specs, comparison). Turn them into a listing video that walks through each card.', example: 'An Amazon-style listing video for a stainless steel water bottle' },
  { id: 'higgsfield-faceless-video', title: 'Faceless explainer', useWhen: 'When you want to explain a topic or tell a story without filming anyone', name: 'Faceless Video', output: 'A narrated explainer or story video with no presenter on camera', tagline: 'Narrated explainers and stories.', category: 'Explainers', motif: 'narration', repository: 'https://github.com/higgsfield-ai/skills/tree/main/higgsfield-faceless-video', license: 'MIT', cover: { video: 'https://static.higgsfield.ai/mcp-landing/skills/faceless-watercolor-chronicle.mp4', poster: 'https://static.higgsfield.ai/mcp-landing/skills/faceless-watercolor-chronicle-thumbnail.webp', aspect: 1.78, source: 'https://higgsfield.ai/skills/faceless' }, media: true,
    technique: 'Follow its faceless-video workflow: write the narration first, keep one consistent visual style, use deliberate diagram-led scenes for explainers (not rapid cuts), and sync scenes to the voiceover.', example: 'A narrated explainer: why the sky is blue' },
  { id: 'higgsfield-brandkit', title: 'Brand intro', useWhen: 'When a brand, shop or event needs an intro with its logo', name: 'Brand Kit', output: 'A brand intro: animated logo reveal plus reusable branded title cards', tagline: 'Logo, palette and brand motion.', category: 'Brand & covers', motif: 'brand', repository: 'https://github.com/higgsfield-ai/skills/tree/main/higgsfield-brandkit', license: 'MIT', cover: { video: 'https://static.higgsfield.ai/public/marketing-studio/hero-banners/marketing-studio-slider-poster-poster.mp4', poster: 'https://static.higgsfield.ai/public/marketing-studio/hero-banners/marketing-studio-slider-poster-poster.webp', aspect: 1.78, source: 'https://higgsfield.ai/marketing-studio' }, media: true,
    technique: 'Follow its brand-system approach: treat supplied logos and colors as fixed, define palette, typography and logo mark, then apply them consistently. Deliver a brand intro with logo animation and reusable branded title cards.', example: 'A brand intro for a coffee shop called North Bean' },
  { id: 'higgsfield-youtube-thumbnail', title: 'Video cover', useWhen: 'When a video is ready and needs a cover that gets clicks', name: 'YouTube Thumbnail', output: 'A video cover image plus a 3-second animated version for the intro', tagline: 'High-click covers for videos.', category: 'Brand & covers', motif: 'thumbnail', repository: 'https://github.com/higgsfield-ai/skills/tree/main/higgsfield-youtube-thumbnail', license: 'MIT', cover: { poster: 'https://a.storyblok.com/f/291136904311624/d49dc637e5/hero.webp', aspect: 1.78, source: 'https://higgsfield.ai/ai-thumbnail-generator' }, media: true,
    technique: 'Follow its thumbnail method: a truthful information-gap concept, one dominant subject, at most three words of large text and strong contrast. Make the cover and a 3-second animated version for the video intro.', example: 'Cover for my video “I rebuilt my app in 7 days”' },
  { id: 'video-shotcraft', title: 'Product promo', useWhen: 'When launching a product or feature and you have real page screenshots', name: 'video-shotcraft', output: 'A product promo cut from your real page screenshots, with beat-synced shots and sound effects', tagline: 'Product promos from shot recipes.', category: 'Product promos', motif: 'promo', repository: 'https://github.com/Vincentwei1021/video-shotcraft', license: 'Apache-2.0', cover: { video: 'https://vincentwei1021.github.io/video-shotcraft/media/assemble-then-type-flyin.mp4#t=2', aspect: 1.78, source: 'https://vincentwei1021.github.io/video-shotcraft/' },
    technique: 'Follow its product-promo workflow: capture real product pages, pick shot recipe cards, storyboard, cut to the beat with sound design and check every frame. Build it as native OpenMotion HTML instead of Remotion.', example: 'A promo for my product built from real page screenshots' },
  { id: 'motion-canvas', title: 'Diagram explainer', useWhen: 'When you need to explain how something works with a diagram', name: 'Motion Canvas', output: 'An explainer that walks through a diagram step by step with synced captions', tagline: 'Animated explainers.', category: 'Explainers', motif: 'scene', repository: 'https://github.com/motion-canvas/motion-canvas', license: 'MIT', cover: { video: motionCanvasVideo, poster: motionCanvasPoster, aspect: 1.78, source: 'OpenMotion sample' },
    technique: 'Use its explainer style: sequential scenes, code-driven tweens, highlighted diagrams and synchronized captions.', example: 'Explain how an API request travels through a system' },
  { id: 'remotion-skills', title: 'Multi-scene short', useWhen: 'When a short video has several distinct scenes, like a launch', name: 'Remotion Skills', output: 'A multi-scene video with clean scene timing, e.g. a 3-scene launch with logo reveal', tagline: 'Agent guidance for video.', category: 'Motion techniques', motif: 'agent', repository: 'https://github.com/remotion-dev/skills', license: 'See repository', cover: { video: 'https://www.remotion.dev/img/homepage-assets-master.mp4', aspect: 1.78, source: 'https://www.remotion.dev/' },
    technique: 'Follow its Agent guidance for structuring a video as scenes, timing with frames, and reusing typed components.', example: 'A 3-scene product launch with a logo reveal' },
  { id: 'motion', title: 'UI motion demo', useWhen: 'When showing an app or dashboard interface changing smoothly', name: 'Motion', output: 'A UI demo where cards and panels smoothly rearrange, expand and morph', tagline: 'Layout transitions.', category: 'Motion techniques', motif: 'layout', repository: 'https://github.com/motiondivision/motion', license: 'MIT', cover: { video: 'https://images.motion.dev/examples/stage/react/app-store/v-85ef4ca3e814/thumb.mp4', poster: 'https://images.motion.dev/examples/stage/react/app-store/v-85ef4ca3e814/thumb.webp', aspect: 1.78, source: 'https://motion.dev/examples' },
    technique: 'Use shared-layout transitions: cards that morph position and size, spring physics and smooth enter/exit.', example: 'A dashboard where cards rearrange to reveal a new feature' },
  { id: 'ola', title: 'Animated numbers', useWhen: 'When showing growth: revenue, users, progress or chart numbers', name: 'Ola', output: 'Animated numbers: counters, progress rings and charts that glide to new values', tagline: 'Smooth value interpolation.', category: 'Motion techniques', motif: 'curve', repository: 'https://github.com/franciscop/ola', license: 'MIT', cover: { video: olaVideo, poster: olaPoster, aspect: 1.78, source: 'OpenMotion sample' },
    technique: 'Interpolate numbers smoothly: counters, progress bars and chart values that glide to new targets.', example: 'Revenue counter climbing from 0 to 1M with a progress ring' },
  { id: 'anime-js', title: 'Staggered entrance', useWhen: 'When a list, icon grid or title should appear in rhythm', name: 'Anime.js', output: 'A rhythmic sequence where icons, text or grid items appear one after another', tagline: 'Timelines and stagger.', category: 'Motion techniques', motif: 'stagger', repository: 'https://github.com/juliangarnier/anime', license: 'MIT', cover: { gif: 'https://raw.githubusercontent.com/juliangarnier/anime/master/assets/images/usage-example-result.gif', aspect: 1.78, source: 'https://github.com/juliangarnier/anime#readme' },
    technique: 'Build one master timeline with staggered elements, offsets and expressive easing.', example: 'A grid of icons that ripple in from the center' },
  { id: 'manim', title: 'Math animation', useWhen: 'When explaining a formula, a curve or a math idea', name: 'Manim', output: 'A math or science animation: plotted curves, transforming formulas, step-by-step proof', tagline: 'Math in motion.', category: 'Explainers', motif: 'math', repository: 'https://github.com/ManimCommunity/manim', license: 'MIT', cover: { video: 'https://docs.manim.community/en/stable/OpeningManim-1.mp4#t=3', aspect: 1.78, source: 'https://docs.manim.community/en/stable/examples.html' },
    technique: 'Recreate its mathematical style in HTML/SVG: plotted functions, transforming equations and step-by-step proofs. Do not install Python or Manim.', example: 'Visualize how a sine wave builds from a rotating circle' },
  { id: 'shifty', title: 'Loading animation', useWhen: 'When you need a loading screen or a transition between scenes', name: 'Shifty', output: 'A loading or transition sequence with distinct easing on each step', tagline: 'Tween playback and easing.', category: 'Motion techniques', motif: 'playback', repository: 'https://github.com/jeremyckahn/shifty', license: 'MIT', cover: { video: shiftyVideo, poster: shiftyPoster, aspect: 1.78, source: 'OpenMotion sample' },
    technique: 'Treat each property change as a tween with explicit easing, pause/seek points and chained steps.', example: 'A loading sequence with three chained easing styles' },
  { id: 'two-js', title: 'Shapes form a logo', useWhen: 'When a logo or illustration should build itself from simple shapes', name: 'Two.js', output: 'A flat vector animation where simple shapes move and assemble into a logo or scene', tagline: 'Animated 2D vector scenes.', category: 'Motion techniques', motif: 'vector', repository: 'https://github.com/jonobr1/two.js', license: 'MIT', cover: { video: twoJsVideo, poster: twoJsPoster, aspect: 1.78, source: 'OpenMotion sample' },
    technique: 'Draw a 2D vector scene of simple shapes and paths, and animate their geometry, stroke and grouping.', example: 'Flat geometric shapes assembling into a logo' },
  { id: 'lottie-web', title: 'Icon animation', useWhen: 'When you need small animated icons or stickers, like checkmarks', name: 'Lottie Web', output: 'Crisp animated icons and stickers, e.g. checkmarks and onboarding icons', tagline: 'Vector animation playback.', category: 'Motion techniques', motif: 'icon', repository: 'https://github.com/airbnb/lottie-web', license: 'MIT', cover: { gif: 'https://raw.githubusercontent.com/airbnb/lottie-web/master/gifs/Example1.gif', aspect: 1.78, source: 'https://github.com/airbnb/lottie-web#readme' },
    technique: 'Use designer-made Lottie animations as layers, or match their crisp vector icon-animation style.', example: 'Animated checkmark and icons for an onboarding video' },
  { id: 'tween-js', title: 'Step-by-step feature tour', useWhen: 'When walking through a feature step by step with callouts', name: 'TweenJS', output: 'A step-by-step feature walkthrough with callouts landing on each beat', tagline: 'Sequenced property animation.', category: 'Motion techniques', motif: 'sequence', repository: 'https://github.com/CreateJS/TweenJS', license: 'MIT', cover: { video: tweenJsVideo, poster: tweenJsPoster, aspect: 1.78, source: 'OpenMotion sample' },
    technique: 'Sequence property animations in order with waits and callbacks so each beat lands on time.', example: 'A step-by-step feature walkthrough with timed callouts' },
  { id: 'lume', title: 'Floating 3D cards', useWhen: 'When product cards or objects should float in 3D', name: 'LUME', output: 'Floating 3D cards or objects with lighting and a moving camera', tagline: '3D scenes with HTML.', category: 'Motion techniques', motif: 'depth', repository: 'https://github.com/lume/lume', license: 'MIT', cover: { video: lumeVideo, poster: lumePoster, aspect: 1.78, source: 'https://lume.io/' },
    technique: 'Compose 3D objects as HTML elements with lighting and camera movement.', example: 'Floating 3D product cards with soft lighting' },
  { id: 'konva', title: 'Whiteboard demo', useWhen: 'When demoing a whiteboard, canvas or design tool', name: 'Konva', output: 'A whiteboard or design-tool style demo where shapes drag, snap and connect', tagline: 'Interactive canvas animation.', category: 'Motion techniques', motif: 'canvas', repository: 'https://github.com/konvajs/konva', license: 'MIT', cover: { video: konvaVideo, poster: konvaPoster, aspect: 1.78, source: 'OpenMotion sample' },
    technique: 'Use a canvas scene graph: layered shapes that drag, snap and transform like a design-tool demo.', example: 'A whiteboard demo where sticky notes snap into a flow' },
  { id: 'blender', title: 'Character animation', useWhen: 'When a mascot or character needs to move naturally', name: 'Blender', output: 'A character animation with anticipation and follow-through, using your rendered clips', tagline: 'Rigging and character animation.', category: 'Motion techniques', motif: 'character', repository: 'https://github.com/blender/blender', license: 'GPL-2.0-or-later', cover: { video: blenderVideo, poster: blenderPoster, aspect: 1.78, source: 'OpenMotion sample' },
    technique: 'Borrow character-animation principles: anticipation, follow-through and posed keyframes. Use rendered Blender clips as assets when provided; do not install Blender.', example: 'A mascot that waves and points to a headline' },
  { id: 'three-js', title: '3D showcase', useWhen: 'When showing a product, globe or object in rotating 3D', name: 'Three.js', output: 'A 3D scene such as a rotating globe or product with camera moves', tagline: 'Animated 3D scenes.', category: 'Motion techniques', motif: 'globe', repository: 'https://github.com/mrdoob/three.js', license: 'MIT', cover: { video: threeJsVideo, poster: threeJsPoster, aspect: 1.78, source: 'Three.js example webgl_animation_keyframes (https://threejs.org/examples/#webgl_animation_keyframes); model Littlest Tokyo by Glen Fox, CC BY 4.0' },
    technique: 'Render a WebGL 3D scene with camera moves, materials and lighting, driven by the composition timeline.', example: 'A rotating 3D globe with connection arcs' },
  { id: 'godot', title: 'Game level-up', useWhen: 'When the video should feel like a game: rewards, levels, combos', name: 'Godot', output: 'A game-style screen: level up, rewards, state changes and camera shake', tagline: 'Game animation systems.', category: 'Motion techniques', motif: 'levelup', repository: 'https://github.com/godotengine/godot', license: 'MIT', cover: { video: 'https://godotengine.org/storage/releases/4.7/images/arealightfhd.webm#t=2', aspect: 1.78, source: 'https://godotengine.org/releases/4.7/' },
    technique: 'Borrow game-animation patterns: state transitions, tweens and camera shake. Recreate them in HTML; do not install Godot.', example: 'A game-style level-up screen with rewards' },
  { id: 'babylon-js', title: '3D product turntable', useWhen: 'When showing a physical product on a lit 3D turntable', name: 'Babylon.js', output: 'A lit 3D product turntable or scene with smooth camera paths', tagline: '3D animation and rendering.', category: 'Motion techniques', motif: 'orbit', repository: 'https://github.com/BabylonJS/Babylon.js', license: 'Apache-2.0', cover: { video: babylonJsVideo, poster: babylonJsPoster, aspect: 1.78, source: 'Babylon.js engine; model AntiqueCamera by UX3D, CC0 (KhronosGroup/glTF-Sample-Assets)' },
    technique: 'Render a physically lit 3D scene with animation groups and smooth camera paths.', example: 'A 3D product turntable with reflections' },
  { id: 'proton', title: 'Particle effects', useWhen: 'When you want confetti, sparks or an ambient particle background', name: 'Proton', output: 'A particle effect such as confetti bursts or an ambient background', tagline: 'Particle emitters and behaviors.', category: 'Motion techniques', motif: 'particles', repository: 'https://github.com/drawcall/Proton', license: 'MIT', cover: { video: protonVideo, poster: protonPoster, aspect: 1.78, source: 'https://drawcall.github.io/Proton/examples/sparks/firework/fireworks.html' },
    technique: 'Add particle emitters with gravity, attraction and fading for celebrations or ambient backgrounds.', example: 'Confetti burst when a goal is reached' },
];

export const aspectRatios = ['16:9', '9:16', '1:1'] as const;
export const durations = [5, 10, 15, 30] as const;
export type SkillParameters = { subject: string; duration: typeof durations[number]; aspect: typeof aspectRatios[number]; style: string };

/** The Agent instruction is the product: copy it into Codex, Claude Code or any MCP client. */
/** Localized instruction templates; locales without an entry fall back to English, like template prompts. */
type PromptKey = keyof typeof skillPrompts.en;
const promptText = (locale: string) => (key: PromptKey, values: Record<string, string | number> = {}) => {
  const table = (skillPrompts as Record<string, Partial<Record<PromptKey, string>>>)[locale] ?? skillPrompts.en;
  return (table[key] ?? skillPrompts.en[key]).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));
};

/** installUrl comes from the running installation (setupGuideUrl), matching template instructions. */
export function skillPrompt(skill: MotionSkill, parameters: SkillParameters, locale: string, installUrl: string) {
  const say = promptText(locale), style = parameters.style.trim();
  const values = { installUrl, name: skill.name, repository: skill.repository ?? '', license: skill.license, output: skill.output,
    subject: parameters.subject.trim() || skill.example, duration: parameters.duration, aspect: parameters.aspect, style, technique: skill.technique };
  return [
    say('intro', values),
    say(skill.repository ? 'borrow' : 'own', values),
    say(skill.repository ? 'reference' : 'ownSource', values),
    '',
    say('brief'), say('deliverable', values), say('content', values), say('format', values), ...(style ? [say('style', values)] : []), say('technique', values),
    '',
    say('steps'), say('step1'), say('step2'), ...(skill.media ? [say('media')] : []), say('step3'), say('step4'), say('step5'),
  ].join('\n');
}

/** A short command for any Agent chat, like a share code: names the skill, the brief and how to install OpenMotion. */
export function skillShortcut(skill: MotionSkill, parameters: SkillParameters, locale: string, installUrl: string) {
  const say = promptText(locale), style = parameters.style.trim();
  return say('shortcut', { title: skill.title, duration: parameters.duration, aspect: parameters.aspect, subject: parameters.subject.trim() || skill.example,
    style: style ? say('shortcutStyle', { style }) : '', repository: skill.repository ?? 'OpenMotion', installUrl });
}
