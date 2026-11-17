// Shared building blocks for page-level reporting modules (template library, Skills, Brand Kit).
// One implementation of the closed-field rules, so every page sends values the server admits.
import { slug } from '../../../tracking/core.ts';
import type { EventFields } from '../../../tracking/core.ts';
import { studioEvents } from '../../../tracking/events.ts';
import type { StudioEvent } from '../../../tracking/events.ts';
import { trackMotion } from './tracking';

export type Fields<E extends StudioEvent> = EventFields<typeof studioEvents[E]>;

/** Fire and forget: reporting never interrupts browsing, copying or downloading. */
export const send = <E extends StudioEvent>(event: E, properties: Fields<E>) => {
  try { void trackMotion(event, properties).catch(() => {}); } catch { /* reporting never interrupts the page */ }
};
export const newTrackingId = () => crypto.randomUUID();
/** The settled search-box value as it is reported: trimmed, control characters removed, at most 100 characters. */
export const searchKeyword = (query: string) => query.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100).trim();
/** A catalogue id is sent only when it is a bounded slug; anything else is left out, never rewritten. */
export const slugField = <K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> =>
  value !== undefined && slug.test(value) ? { [key]: value } as Record<K, string> : {};
/** Whether the application is shown inside a host (same rule as the studio page view). */
export const embeddedView = () => new URLSearchParams(location.search).get('embed') === '1';
