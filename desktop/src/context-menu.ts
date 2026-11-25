import type { ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron';
import type { DesktopPlatform } from '../../shared/platform-host.ts';
import { isAllowedExternalUrl } from './window-policy.ts';

export type ContextMenuInput = Pick<
  ContextMenuParams,
  'isEditable' | 'selectionText' | 'linkURL' | 'misspelledWord' | 'dictionarySuggestions' | 'editFlags'
>;

export type ContextMenuActions = {
  platform: DesktopPlatform;
  locale?: string;
  onReplaceMisspelling?: (suggestion: string) => void;
  onLookUpSelection?: () => void;
  onOpenLinkExternal?: (url: string) => void;
  onCopyText?: (text: string) => void;
};

function isZhLocale(locale?: string): boolean {
  return Boolean(locale && locale.toLowerCase().startsWith('zh'));
}

function truncateLabelText(text: string, maxChars = 24): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars - 1)}…`;
}

/**
 * Pure builder for native desktop context menus (text editing, spellcheck,
 * macOS Look Up, selection copy, and safe external link actions).
 * Returns an empty array when no contextual action applies so empty canvas
 * right-clicks remain unobtrusive.
 */
export function buildContextMenuTemplate(
  params: ContextMenuInput,
  options: ContextMenuActions,
): MenuItemConstructorOptions[] {
  const isMac = options.platform === 'darwin';
  const zh = isZhLocale(options.locale);
  const items: MenuItemConstructorOptions[] = [];

  const selection = (params.selectionText ?? '').trim();
  const linkUrl = (params.linkURL ?? '').trim();
  const safeLink = linkUrl && isAllowedExternalUrl(linkUrl) ? linkUrl : '';

  if (params.isEditable) {
    const suggestions = Array.isArray(params.dictionarySuggestions)
      ? params.dictionarySuggestions.slice(0, 5)
      : [];
    if (params.misspelledWord && suggestions.length > 0) {
      for (const suggestion of suggestions) {
        items.push({
          label: suggestion,
          click: () => options.onReplaceMisspelling?.(suggestion),
        });
      }
      items.push({ type: 'separator' });
    }

    if (isMac && selection && options.onLookUpSelection) {
      items.push({
        label: zh
          ? `查询“${truncateLabelText(selection)}”`
          : `Look Up “${truncateLabelText(selection)}”`,
        click: () => options.onLookUpSelection?.(),
      });
      items.push({ type: 'separator' });
    }

    items.push(
      { role: 'cut', enabled: params.editFlags?.canCut ?? Boolean(selection) },
      { role: 'copy', enabled: params.editFlags?.canCopy ?? Boolean(selection) },
      { role: 'paste', enabled: params.editFlags?.canPaste ?? true },
      ...(isMac
        ? ([{ role: 'pasteAndMatchStyle', enabled: params.editFlags?.canPaste ?? true }] as MenuItemConstructorOptions[])
        : []),
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags?.canSelectAll ?? true },
    );
  } else if (selection) {
    if (isMac && options.onLookUpSelection) {
      items.push({
        label: zh
          ? `查询“${truncateLabelText(selection)}”`
          : `Look Up “${truncateLabelText(selection)}”`,
        click: () => options.onLookUpSelection?.(),
      });
      items.push({ type: 'separator' });
    }
    items.push({ role: 'copy' });
  }

  if (safeLink) {
    if (items.length > 0) {
      items.push({ type: 'separator' });
    }
    items.push(
      {
        label: zh ? '在浏览器中打开链接' : 'Open Link in Browser',
        click: () => options.onOpenLinkExternal?.(safeLink),
      },
      {
        label: zh ? '拷贝链接地址' : 'Copy Link Address',
        click: () => options.onCopyText?.(safeLink),
      },
    );
  }

  return items;
}

export function attachNativeContextMenu(
  webContents: WebContents,
  options: {
    platform: DesktopPlatform;
    getLocale: () => string;
    openExternal: (url: string) => Promise<unknown> | unknown;
    writeClipboardText: (text: string) => void;
    popupTemplate: (template: MenuItemConstructorOptions[]) => void;
  },
): void {
  webContents.on('context-menu', (_event, params) => {
    const template = buildContextMenuTemplate(params, {
      platform: options.platform,
      locale: options.getLocale(),
      onReplaceMisspelling: suggestion => {
        if (!webContents.isDestroyed()) {
          webContents.replaceMisspelling(suggestion);
        }
      },
      onLookUpSelection:
        options.platform === 'darwin'
          ? () => {
              if (!webContents.isDestroyed()) {
                webContents.showDefinitionForSelection();
              }
            }
          : undefined,
      onOpenLinkExternal: url => {
        void options.openExternal(url);
      },
      onCopyText: text => {
        options.writeClipboardText(text);
      },
    });

    if (template.length === 0) return;
    options.popupTemplate(template);
  });
}
