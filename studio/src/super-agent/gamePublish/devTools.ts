/**
 * Local developer tools some platforms need before the user can upload the game.
 *
 * OpenDesign does not check the machine yet: the dialog links to the official download and
 * continues when the user says the tool is installed.
 *
 * TODO(local service): detect the tool and return { installed, version, path, via }:
 *  - WeChat: macOS /Applications/wechatwebdevtools.app (CLI Contents/MacOS/cli);
 *    Windows %ProgramFiles(x86)%\Tencent\微信web开发者工具\cli.bat. `cli islogin` checks it starts;
 *    uploading needs Settings > Security > Service port turned on, then
 *    `cli upload --project <dir> -v <version> -d <desc>`. miniprogram-ci (npm, upload key + IP
 *    allowlist) also counts and needs no desktop app.
 *  - Douyin Mini Game: macOS /Applications/抖音开发者工具.app; Windows install directory from the
 *    registry uninstall entry. Command-line upload: npm tt-minigame-ide-cli (`tmg login`,
 *    `tmg upload`) — confirm the command against the current Douyin docs.
 *  - QQ Mini Game: macOS /Applications/QQ小程序开发者工具.app (CLI Contents/MacOS/cli, same
 *    commands as the WeChat CLI); Windows install directory from the registry.
 * Once detection exists, re-check on window focus so the dialog can close by itself.
 */
export type GamePublishDevToolId = 'wechat-devtools' | 'douyin-devtools' | 'qq-devtools';

export interface GamePublishDevTool {
  id: GamePublishDevToolId;
  name: string;
  /** Why the platform needs the tool. */
  why: string;
  /** Official download page. */
  downloadHref: string;
  /** Also accepted instead of the desktop app, if any. */
  alternative?: string;
}

export const GAME_PUBLISH_DEV_TOOLS: Record<GamePublishDevToolId, GamePublishDevTool> = {
  'wechat-devtools': {
    id: 'wechat-devtools',
    name: 'WeChat DevTools',
    why: 'WeChat\'s desktop tool for running and debugging a Mini Game on your computer.',
    downloadHref: 'https://developers.weixin.qq.com/minigame/dev/devtools/download.html',
  },
  'douyin-devtools': {
    id: 'douyin-devtools',
    name: 'Douyin DevTools',
    why: 'Douyin checks the game in its simulator and uploads the package through this tool.',
    downloadHref: 'https://developer.open-douyin.com/docs/resource/zh-CN/mini-game/develop/dev-tools/developer-instrument-update-and-download',
  },
  'qq-devtools': {
    id: 'qq-devtools',
    name: 'QQ Mini Program DevTools',
    why: 'QQ checks the game in its simulator and uploads the package through this tool.',
    downloadHref: 'https://q.qq.com/wiki/tools/devtool/',
  },
};

export function gamePublishDevTool(id: GamePublishDevToolId | undefined): GamePublishDevTool | undefined {
  return id ? GAME_PUBLISH_DEV_TOOLS[id] : undefined;
}
