import { expect, it } from 'vitest';
import { styleHistoryLabel } from './styleHistory';
import { historyEntryLabel } from './historyMessages';
import { systemMessage } from './systemMessages';
import { languages, translate } from './messages';

const zh = (message: string, values?: Record<string, string | number>) => translate('zh-CN', message, values);

it('names the authored target and changed property without adding a line', () => {
  const label = styleHistoryLabel('Make it\nmove.', { 'font-size': '96px' });
  expect(historyEntryLabel(label, zh)).toBe('Make it move. · 字号: 96px');
  expect(historyEntryLabel(`Undid: ${label}`, zh)).toBe('撤销：Make it move. · 字号: 96px');
});

it('describes the overall opacity multiplier without exposing its filter implementation', () => {
  const label = styleHistoryLabel('Title', { '--hf-layer-opacity': '0.47', filter: 'blur(2px) opacity(var(--hf-layer-opacity))' });
  expect(historyEntryLabel(label, zh)).toBe('Title · 不透明度: 47%');
  expect(historyEntryLabel(styleHistoryLabel('Title', { opacity: '0' }), zh)).toBe('Title · 不透明度: 0%');
});

it('describes the applied, undone and redone opacity in Chinese for stored style labels', () => {
  const label = 'Edit layer style: ["avatar_3",[["opacity","78%"]]]';
  expect(systemMessage('Set layer opacity to 78%', zh)).toBe('已将图层不透明度设为 78%');
  expect(systemMessage(label, zh)).toBe('已将图层不透明度设为 78%');
  for (const separator of [' ', ': ']) {
    expect(systemMessage(`Undid${separator}${label}`, zh)).toBe('已撤销将图层不透明度设为 78% 的操作');
    expect(systemMessage(`Redid${separator}${label}`, zh)).toBe('已重做将图层不透明度设为 78% 的操作');
  }
  expect(systemMessage('Edit layer style: ["avatar_3",', zh)).toBe('已更新图层样式');
  expect(systemMessage(`Undid: ${styleHistoryLabel('avatar_3', { color: 'red', opacity: '0.5' })}`, zh)).toBe('已撤销图层样式更改');
});

it('localizes properties in all locales while preserving punctuation in authored names', () => {
  const target = 'My "Title" · 日本語';
  const label = styleHistoryLabel(target, { color: '#123456', 'font-size': '32px' });
  for (const { locale } of languages) {
    const t = (message: string) => translate(locale, message);
    expect(historyEntryLabel(label, t)).toBe(`${target} · ${t('Color')}: #123456 / ${t('Font size')}: 32px`);
  }
});

it('keeps legacy and malformed labels readable without guessing missing changes', () => {
  expect(historyEntryLabel('Edit layer style', zh)).toBe('编辑图层样式');
  for (const label of ['Edit layer style: invalid', 'Edit layer style: ["Title",null]', 'Edit layer style: ["Title",[["color",{}]]]']) {
    expect(historyEntryLabel(label, zh)).toBe(label);
  }
});
