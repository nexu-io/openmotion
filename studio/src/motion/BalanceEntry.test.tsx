// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { studioEvents } from '../../../tracking/events.ts';
import { validProperties } from '../../../tracking/core.ts';
import { Menu } from '../components/ui/Menu';
import { I18nProvider } from '../i18n/I18n';
import { BalanceMenuItem, BalanceRing, formatBalance, planLabel, quotaShare } from './BalanceEntry';
import { trackMotion } from './tracking';

vi.mock('./tracking', () => ({ trackMotion: vi.fn(async () => 'queued') }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.mocked(trackMotion).mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('formats the balance as dollars with two decimals', () => {
  expect(formatBalance('4.8')).toBe('$4.80');
  expect(formatBalance('12.3456')).toBe('$12.35');
  expect(formatBalance('0')).toBe('$0.00');
});

it('reads the share of the plan quota left, and nothing when there is no quota', () => {
  expect(quotaShare({ kind: '7d', remainingPercent: 62, resetsAt: null })).toBe(0.62);
  expect(quotaShare({ kind: '5h', remainingPercent: 0, resetsAt: null })).toBe(0);
  expect(quotaShare(undefined)).toBeNull();
});

it('draws the credits left as the avatar ring', () => {
  act(() => root.render(<BalanceRing share={0.62} />));
  const paths = container.querySelectorAll('path');
  expect(paths).toHaveLength(2);
  expect(paths[1].getAttribute('stroke-dasharray')).toBe('62 100');
  act(() => root.render(<BalanceRing share={0} />));
  expect(container.querySelectorAll('path')).toHaveLength(1);
});

const renderItem = (props: Parameters<typeof BalanceMenuItem>[0]) => act(() => root.render(<I18nProvider initialLocale="zh-CN"><Menu open trigger={<button type="button">menu</button>}>
  <BalanceMenuItem {...props} />
</Menu></I18nProvider>));
const menuItem = () => [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent?.includes('剩余')) as HTMLElement;

it('shows the plan quota left as a percentage and bar, with the wallet below, and opens Subscription & usage', async () => {
  const openUsage = vi.fn();
  renderItem({ balance: '12.4', quota: { kind: '7d', remainingPercent: 62, resetsAt: null }, trackingPage: 'explore', openUsage });
  await act(async () => {});
  const item = menuItem();
  expect(item.textContent).toContain('套餐额度');
  expect(item.textContent).toContain('剩余 62%');
  expect(item.textContent).toContain('可用余额 $12.40');
  expect(item.querySelector('[style*="width: 62%"]')).not.toBeNull();
  await act(async () => { item.click(); });
  expect(openUsage).toHaveBeenCalledTimes(1);
  const click = vi.mocked(trackMotion).mock.calls.find(([event]) => event === 'ui_click')![1] as Record<string, unknown>;
  expect(click).toMatchObject({ page_name: 'explore', area: 'header', element: 'open_balance' });
  expect(validProperties(studioEvents, 'ui_click', click)).toBe(true);
});

it('falls back to the wallet balance left, with no bar, when the plan has no quota', async () => {
  renderItem({ balance: '5', trackingPage: 'explore', openUsage: vi.fn() });
  await act(async () => {});
  const item = menuItem();
  expect(item.textContent).toContain('可用余额');
  expect(item.textContent).toContain('剩余 $5.00');
  expect(item.querySelector('[style*="width"]')).toBeNull();
});

it('names the plan under the account name', () => {
  const t = (message: string, values?: Record<string, string | number>) => ({ 'Free plan': '免费版', '{plan} plan': `${values?.plan} 套餐` })[message] ?? message;
  expect(planLabel('free', t)).toBe('免费版');
  expect(planLabel('plus', t)).toBe('Plus 套餐');
  expect(planLabel('Pro', t)).toBe('Pro 套餐');
});
