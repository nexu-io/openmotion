// Standalone Studio keeps its saved choice; embed=1 follows the host browser's
// color scheme without persisting it. index.html mirrors this before first paint.
import { useSyncExternalStore } from "react";
import {
  readStudioUiPreferences,
  writeStudioUiPreferences,
  type StudioTheme,
  type StudioThemePreference,
} from "./studioUiPreferences";

export function savedStudioTheme(): StudioTheme {
  const preference = savedStudioThemePreference();
  return preference === 'system' ? systemTheme() : preference;
}

export function savedStudioThemePreference(): StudioThemePreference {
  return readStudioUiPreferences().theme ?? 'light';
}
const systemTheme = (): StudioTheme => window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';

export function shownStudioTheme(): StudioTheme {
  return document.documentElement.dataset.theme === "paper" ? "light" : "dark";
}

function applyStudioTheme(theme: StudioTheme): void {
  const root = document.documentElement;
  if (theme === "light") root.dataset.theme = "paper";
  else delete root.dataset.theme;
  const chromeColor = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const value = chromeColor?.dataset[theme];
  if (chromeColor && value) chromeColor.content = value;
}

export function studioUsesHostTheme(): boolean {
  return new URLSearchParams(location.search).get("embed") === "1";
}

/** Embedded hosts and standalone System mode track the same media preference. */
export function bindEmbeddedStudioTheme(): () => void {
  const root = document.documentElement;
  root.dataset.themePreference = savedStudioThemePreference();
  if (!window.matchMedia) return () => {};
  const preference = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    if (studioUsesHostTheme() || root.dataset.themePreference === 'system') applyStudioTheme(preference.matches ? "dark" : "light");
  };
  const storage = (event: StorageEvent) => {
    if (event.key !== 'hf-studio-ui-preferences' && event.key !== null) return;
    const choice = savedStudioThemePreference(); root.dataset.themePreference = choice;
    applyStudioTheme(studioUsesHostTheme() || choice === 'system' ? systemTheme() : choice);
  };
  apply();
  preference.addEventListener("change", apply);
  window.addEventListener('storage', storage);
  return () => { preference.removeEventListener("change", apply); window.removeEventListener('storage', storage); };
}

export function setStudioTheme(theme: StudioThemePreference): void {
  writeStudioUiPreferences({ theme });
  document.documentElement.dataset.themePreference = theme;
  applyStudioTheme(studioUsesHostTheme() || theme === 'system' ? systemTheme() : theme);
}

function subscribe(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme", 'data-theme-preference'] });
  return () => observer.disconnect();
}

export function useShownStudioTheme(): StudioTheme {
  return useSyncExternalStore(subscribe, shownStudioTheme);
}

export function useStudioThemePreference(): StudioThemePreference {
  return useSyncExternalStore(subscribe, () => {
    const value = document.documentElement.dataset.themePreference;
    return value === 'light' || value === 'dark' || value === 'system' ? value : savedStudioThemePreference();
  });
}
