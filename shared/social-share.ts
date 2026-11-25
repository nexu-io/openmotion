import { safeHttpsUrl } from './growth-surfaces.ts';

export const SOCIAL_SHARE_PLATFORMS = ['x', 'linkedin', 'reddit', 'telegram', 'weibo'] as const;
export type SocialSharePlatform = (typeof SOCIAL_SHARE_PLATFORMS)[number];

export type SocialShareTarget = {
  platform: SocialSharePlatform;
  label: string;
  icon: string;
  shareUrl: string;
};

export type SocialSharePayload = {
  shareUrl: string;
  copyText: string;
  platforms: SocialShareTarget[];
};

const DEFAULT_SHARE_URL = 'https://open-design.ai';

export function normalizeFeedbackText(raw: string): string | undefined {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

export function buildSocialSharePayload(options: {
  title?: string | null;
  shareUrl?: string | null;
  locale?: string;
}): SocialSharePayload {
  const cleanUrl = safeHttpsUrl(options.shareUrl) ?? DEFAULT_SHARE_URL;
  const cleanTitle = (options.title ?? '').trim() || 'OpenMotion Studio';
  const isZh = (options.locale ?? '').toLowerCase().startsWith('zh');

  const text = isZh
    ? `我用 OpenMotion 制作了「${cleanTitle}」：${cleanUrl}`
    : `Created "${cleanTitle}" with OpenMotion: ${cleanUrl}`;

  const shortText = isZh
    ? `我用 OpenMotion 制作了「${cleanTitle}」`
    : `Created "${cleanTitle}" with OpenMotion`;

  const targetsById: Record<SocialSharePlatform, SocialShareTarget> = {
    x: {
      platform: 'x',
      label: 'X',
      icon: 'twitter-x-line',
      shareUrl: `https://x.com/intent/tweet?text=${encodeURIComponent(shortText)}&url=${encodeURIComponent(cleanUrl)}`,
    },
    linkedin: {
      platform: 'linkedin',
      label: 'LinkedIn',
      icon: 'linkedin-box-line',
      shareUrl: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(cleanUrl)}`,
    },
    reddit: {
      platform: 'reddit',
      label: 'Reddit',
      icon: 'reddit-line',
      shareUrl: `https://www.reddit.com/submit?url=${encodeURIComponent(cleanUrl)}&title=${encodeURIComponent(cleanTitle)}`,
    },
    telegram: {
      platform: 'telegram',
      label: 'Telegram',
      icon: 'telegram-line',
      shareUrl: `https://t.me/share/url?url=${encodeURIComponent(cleanUrl)}&text=${encodeURIComponent(shortText)}`,
    },
    weibo: {
      platform: 'weibo',
      label: 'Weibo',
      icon: 'weibo-line',
      shareUrl: `https://service.weibo.com/share/share.php?url=${encodeURIComponent(cleanUrl)}&title=${encodeURIComponent(shortText)}`,
    },
  };

  const order: readonly SocialSharePlatform[] = isZh
    ? ['weibo', 'x', 'telegram', 'linkedin', 'reddit']
    : ['x', 'linkedin', 'reddit', 'telegram', 'weibo'];

  return {
    shareUrl: cleanUrl,
    copyText: text,
    platforms: order.map(platform => targetsById[platform]),
  };
}
