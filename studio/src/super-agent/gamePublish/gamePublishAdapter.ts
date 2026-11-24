/**
 * Real calls the publish wizard makes.
 *
 * - publishGameLink: the same OpenDesign Cloud publish the toolbar "Share" button uses
 *   (webPublishClient, targetKind 'game'). Returns the real public URL or throws.
 * - Packages are built in the browser (gamePackage.ts).
 *
 * Not connected (needs a local service or backend, so the wizard sends the user to the official
 * console instead and records only what the user says they did):
 *  - detecting WeChat / Douyin / QQ developer tools on the machine (see devTools.ts);
 *  - converting the game into a WeChat / Douyin / QQ Mini Game project and uploading it
 *    (miniprogram-ci `ci.upload`, `cli upload`, tt-minigame-ide-cli `tmg upload`);
 *  - itch.io `butler push`, Telegram bot creation, review-status callbacks.
 */
import { WebPublishApiError, webPublishClient } from '../../components/webPublishClient';

export interface GamePublishLinkTarget {
  /** Game ID used by the toolbar Share button. */
  targetId: string;
  filePath?: string;
  embedUrl?: string;
  title?: string;
}

export interface GamePublishLinkError {
  message: string;
  /** The user must sign in to OpenDesign first. */
  authRequired: boolean;
}

export async function publishGameLink(target: GamePublishLinkTarget): Promise<{ url: string; updated: boolean }> {
  const published = await webPublishClient.publish('game', target.targetId, {
    filePath: target.filePath,
    embedUrl: target.embedUrl,
    deployMode: 'publish',
    name: target.title,
  });
  if (!published.url) throw new Error('Published, but no link came back');
  return { url: published.url, updated: published.updated };
}

export function describeLinkError(error: unknown): GamePublishLinkError {
  const authRequired = error instanceof WebPublishApiError && (error.status === 401 || error.code === 'AUTH_REQUIRED');
  return { message: error instanceof Error ? error.message : String(error), authRequired };
}
