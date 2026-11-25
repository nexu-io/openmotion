/**
 * Publish targets for the game "Publish" wizard.
 *
 * Each target is the list of steps the user goes through. A step is one of:
 *  - guide (default): the user does it in the platform's official console, then says it is done;
 *  - pick / fields: the user chooses or types something the next step uses;
 *  - package: OpenDesign builds a real package in the browser and the user downloads it;
 *  - link: the real OpenDesign game link (published with the toolbar Share capability).
 * Nothing here claims a platform result the wizard cannot see: result copy records what the
 * user said they did. What needs a local service or backend is listed in gamePublishAdapter.ts.
 *
 * All copy is an English source key translated through `t()` (game-publish-ui.json).
 */
import type { GamePackageTarget } from './gamePackage';
import type { GamePublishDevToolId } from './devTools';
import { PLAYABLE_NETWORKS } from './playableNetworks';
import type { WechatStepKey } from './wechatClient';
import type { platformIcons } from '../../../../packages/design-system/platform-icons.js';

export type GamePublishPlatformId = 'wechat' | 'douyin-minigame' | 'qq' | 'xiaohongshu' | 'douyin' | 'itch' | 'telegram' | 'playable-ad';

export interface GamePublishField {
  label: string;
  placeholder?: string;
}

export interface GamePublishStep {
  kind?: 'guide' | 'package' | 'link';
  /** Short name of the step. */
  short: string;
  title: string;
  /** Why the user does this step (or what the package is for). */
  why: string;
  /** Numbered sub-steps, also shown in the chat card. */
  todo: string[];
  fields?: GamePublishField[];
  /** Options the user chooses personally (never preselected). */
  pick?: string[];
  /** Package built for a `package` step. */
  packageTarget?: GamePackageTarget;
  links?: Array<{ label: string; href: string }>;
  cta: string;
}

export interface GamePublishPlatform {
  id: GamePublishPlatformId;
  group: 'China' | 'Global' | 'Ads';
  name: string;
  /** Short effort summary shown on the platform tile. */
  effort: string;
  badge: string;
  /** Platform artwork from the design system (packages/design-system/platform-icons.js); otherwise the badge is shown. */
  icon?: keyof typeof platformIcons;
  /** Local developer tool the user confirms before the steps (see devTools.ts). */
  devTool?: GamePublishDevToolId;
  steps: GamePublishStep[];
  /** What the user did, in their words. */
  resultTitle: string;
  resultDetail: string;
  resultAction?: string;
  resultHref?: string;
}

/** Platforms shown in the first version. The others stay in the code and come back later. */
export const ENABLED_PUBLISH_PLATFORMS: readonly GamePublishPlatformId[] = ['wechat'];

const WECHAT_CONSOLE = { label: 'Open WeChat console', href: 'https://mp.weixin.qq.com/' };
const DOUYIN_CONSOLE = { label: 'Open Douyin developer console', href: 'https://developer.open-douyin.com/console' };
const QQ_CONSOLE = { label: 'Open QQ console', href: 'https://q.qq.com/' };

export const GAME_PUBLISH_PLATFORMS: readonly GamePublishPlatform[] = [
  {
    id: 'wechat',
    group: 'China',
    name: 'WeChat Mini Game',
    effort: 'The Agent guides you step by step · port, preview and upload here',
    badge: '微',
    icon: 'wechat-minigame',
    devTool: 'wechat-devtools',
    // Guided by the Agent in the conversation (skills/openmotion-game/references/wechat-minigame-port.md);
    // the panel shows WECHAT_STEPS from the local service's progress record.
    steps: [],
    resultTitle: 'Released on WeChat',
    resultDetail: 'Every WeChat user can find and play it.',
    resultAction: 'Open WeChat console',
    resultHref: WECHAT_CONSOLE.href,
  },
  {
    id: 'douyin-minigame',
    group: 'China',
    name: 'Douyin Mini Game',
    effort: '3 steps in Douyin tools · not automated yet',
    badge: '抖',
    devTool: 'douyin-devtools',
    steps: [
      {
        short: 'Account',
        title: 'Get a Mini Game AppID',
        why: 'Only your Douyin developer account can get an AppID.',
        todo: ['Sign in to the Douyin developer console; register a Mini Game if you do not have one', 'Copy the AppID'],
        links: [DOUYIN_CONSOLE],
        cta: 'Done',
      },
      {
        short: 'Upload',
        title: 'Create the project in Douyin DevTools and upload',
        why: 'OpenDesign cannot turn the game into a Mini Game project or upload it yet, so this is done in Douyin DevTools.',
        todo: ['Sign in to Douyin DevTools and create a Mini Game project with your AppID', 'Port the game into the project and run it in the simulator', 'Upload a test version'],
        cta: 'I uploaded it',
      },
      {
        short: 'Review',
        title: 'Try it, then submit for review',
        why: 'Douyin only lets you submit for review yourself.',
        todo: ['Scan the test code with Douyin and play the test version', 'Submit it in the Douyin developer console under Version management'],
        links: [DOUYIN_CONSOLE],
        cta: 'I submitted it',
      },
    ],
    resultTitle: 'You submitted it to Douyin',
    resultDetail: 'The review result shows in the Douyin developer console',
    resultAction: 'Open Douyin developer console',
    resultHref: DOUYIN_CONSOLE.href,
  },
  {
    id: 'qq',
    group: 'China',
    name: 'QQ Mini Game',
    effort: '3 steps in QQ tools · not automated yet',
    badge: 'Q',
    devTool: 'qq-devtools',
    steps: [
      {
        short: 'Account',
        title: 'Get a Mini Game AppID',
        why: 'Only your QQ Mini Program account can get an AppID.',
        todo: ['Sign in to the QQ Mini Program console and create a Mini Game', 'Copy the AppID'],
        links: [QQ_CONSOLE],
        cta: 'Done',
      },
      {
        short: 'Upload',
        title: 'Create the project in QQ DevTools and upload',
        why: 'OpenDesign cannot turn the game into a Mini Game project or upload it yet, so this is done in QQ DevTools.',
        todo: ['Sign in to QQ Mini Program DevTools and create a Mini Game project with your AppID', 'Port the game into the project and run it in the simulator', 'Upload a test version'],
        cta: 'I uploaded it',
      },
      {
        short: 'Review',
        title: 'Try it, then submit for review',
        why: 'QQ only lets you submit for review yourself.',
        todo: ['Play the test version in QQ', 'Submit it in the QQ Mini Program console'],
        links: [QQ_CONSOLE],
        cta: 'I submitted it',
      },
    ],
    resultTitle: 'You submitted it to QQ',
    resultDetail: 'The review result shows in the QQ Mini Program console',
    resultAction: 'Open QQ console',
    resultHref: QQ_CONSOLE.href,
  },
  {
    id: 'xiaohongshu',
    group: 'China',
    name: 'Xiaohongshu Mini Tool',
    effort: 'Download the package · upload in Builder Hub',
    badge: '书',
    steps: [
      {
        kind: 'package',
        packageTarget: 'xiaohongshu',
        short: 'Package',
        title: 'Download the offline package',
        why: 'Xiaohongshu does not allow inline scripts, so the scripts are moved into files.',
        todo: ['Download the zip'],
        cta: 'Downloaded',
      },
      {
        short: 'Upload',
        title: 'Upload in Builder Hub and submit',
        why: 'Uploading needs your Xiaohongshu account.',
        todo: ['Open the Xiaohongshu creator platform, then Builder Hub, then Mini Tools', 'Create a Mini Tool and upload the zip', 'Fix anything its check reports, then submit for review'],
        links: [
          { label: 'Open Builder Hub', href: 'https://creator.xiaohongshu.com/new/red-app' },
          { label: 'Mini Tool docs', href: 'https://miniapp-sandbox.xiaohongshu.com/minitool/doc' },
        ],
        cta: 'I submitted it',
      },
    ],
    resultTitle: 'You submitted it to Xiaohongshu',
    resultDetail: 'The review result shows in Builder Hub',
    resultAction: 'Open Builder Hub',
    resultHref: 'https://creator.xiaohongshu.com/new/red-app',
  },
  {
    id: 'douyin',
    group: 'China',
    name: 'Douyin Interactive Space',
    effort: 'Invite code · download the package · upload yourself',
    badge: '抖',
    steps: [
      {
        kind: 'package',
        packageTarget: 'douyin',
        short: 'Package',
        title: 'Download the package',
        why: 'Interactive Space takes a zip with index.html at the root, up to 8 MB.',
        todo: ['Download the zip'],
        cta: 'Downloaded',
      },
      {
        short: 'Upload',
        title: 'Create the work, upload and publish',
        why: 'Interactive Space opens by invite code, and only your Douyin account can upload.',
        todo: [
          'Sign in to the Douyin creator platform; enter an invite code if Interactive Space is not open yet',
          'Create a work, fill in the title and icon, and upload the zip',
          'Scan the test code with the Douyin app and play it',
          'Click Publish to submit for review',
        ],
        links: [{ label: 'Open Douyin creator platform', href: 'https://vcreate.douyin.com/' }],
        cta: 'I submitted it',
      },
    ],
    resultTitle: 'You submitted it to Douyin',
    resultDetail: 'Douyin sends the review result as an in-app message',
    resultAction: 'Open Douyin creator platform',
    resultHref: 'https://vcreate.douyin.com/',
  },
  {
    id: 'itch',
    group: 'Global',
    name: 'itch.io',
    effort: 'Download the zip · upload on itch.io',
    badge: 'it',
    steps: [
      {
        kind: 'package',
        packageTarget: 'itch',
        short: 'Package',
        title: 'Download the HTML5 zip',
        why: 'itch.io plays HTML5 games from a zip with index.html at the root.',
        todo: ['Download the zip'],
        cta: 'Downloaded',
      },
      {
        short: 'Upload',
        title: 'Create the page and upload',
        why: 'Creating the page needs your itch.io account.',
        todo: ['Create a new project', 'Set Kind of project to HTML and upload the zip', 'Tick "This file will be played in the browser"', 'Save, then set the page to Public'],
        links: [{ label: 'Create project', href: 'https://itch.io/game/new' }],
        cta: 'I published it',
      },
    ],
    resultTitle: 'You published it on itch.io',
    resultDetail: 'Your page is on your itch.io dashboard',
    resultAction: 'Open itch.io dashboard',
    resultHref: 'https://itch.io/dashboard',
  },
  {
    id: 'telegram',
    group: 'Global',
    name: 'Telegram Mini App',
    effort: 'Uses the OpenDesign link · set up in BotFather',
    badge: 'TG',
    steps: [
      {
        kind: 'link',
        short: 'Game link',
        title: 'Get the game link',
        why: 'A Telegram Mini App opens a web address. The OpenDesign game link is used for it.',
        todo: ['Publish the OpenDesign link'],
        cta: 'Next step',
      },
      {
        short: 'Bot',
        title: 'Attach the game to a bot',
        why: 'Only you can create bots with BotFather.',
        todo: ['Open BotFather and send /newbot to create a bot', 'Send /mybots, choose your bot, then Bot Settings, then Menu Button, and paste the game link'],
        links: [{ label: 'Open BotFather', href: 'https://t.me/BotFather' }],
        cta: 'Done',
      },
    ],
    resultTitle: 'You attached it to your Telegram bot',
    resultDetail: 'It opens from the bot menu button',
  },
  {
    id: 'playable-ad',
    group: 'Ads',
    name: 'Playable ad export',
    effort: 'No account needed · download and upload yourself',
    badge: 'Ad',
    steps: [
      {
        short: 'Network',
        title: 'Which ad network?',
        why: 'You decide where to advertise; the package follows that network\'s rules.',
        todo: ['Choose one ad network'],
        pick: PLAYABLE_NETWORKS.map(network => network.name),
        cta: 'Next step',
      },
      {
        short: 'Store links',
        title: 'Add your store links',
        why: 'Only you know where players should download the app. The store button opens these links.',
        todo: ['Paste the App Store link', 'Paste the Google Play link'],
        fields: [
          { label: 'iOS App Store link', placeholder: 'https://apps.apple.com/app/id…' },
          { label: 'Google Play link', placeholder: 'https://play.google.com/store/apps/details?id=…' },
        ],
        cta: 'Build package',
      },
      {
        kind: 'package',
        packageTarget: 'playable',
        short: 'Download',
        title: 'Check and download',
        why: 'Checked against the network rules on the file you download. Upload it in your ad account and preview it there.',
        todo: ['Download the package', 'Upload it in your ad network console and preview it there'],
        cta: 'I downloaded it',
      },
    ],
    resultTitle: 'You downloaded the playable ad package',
    resultDetail: 'Upload it in your ad account and preview it there',
  },
];

export function gamePublishPlatform(id: GamePublishPlatformId | undefined): GamePublishPlatform | undefined {
  return GAME_PUBLISH_PLATFORMS.find(platform => platform.id === id);
}

/** Store links must be https URLs; at least one is needed. */
export function storeLinkProblem(inputs: Record<string, string>): string | undefined {
  const ios = inputs['iOS App Store link']?.trim();
  const android = inputs['Google Play link']?.trim();
  if (!ios && !android) return 'Add at least one store link.';
  for (const value of [ios, android]) {
    if (value && !/^https:\/\/\S+$/i.test(value)) return 'Store links must start with https://';
  }
  return undefined;
}

/** WeChat progress shown in the panel, in order. Names match the steps the Agent guides (one message each). */
export const WECHAT_STEPS: ReadonlyArray<{ key: WechatStepKey; name: string; later?: boolean; byUser?: boolean }> = [
  { key: 'account', name: 'Mini Game account', byUser: true },
  { key: 'appid', name: 'AppID' },
  { key: 'key', name: 'Upload key' },
  { key: 'ip', name: 'IP allowlist' },
  { key: 'port', name: 'Port to Mini Game' },
  { key: 'preview', name: 'Preview code' },
  { key: 'upload', name: 'Upload' },
  { key: 'testers', name: 'Trial version and testers', byUser: true },
  { key: 'category', name: 'Service category', later: true, byUser: true },
  { key: 'review', name: 'Review', later: true, byUser: true },
  { key: 'filing', name: 'Filing (owner only)', later: true, byUser: true },
  { key: 'release', name: 'Release on WeChat', later: true, byUser: true },
];
