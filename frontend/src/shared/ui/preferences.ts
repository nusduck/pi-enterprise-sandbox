/**
 * Per-browser UI preferences (localStorage), shared live between components:
 * a write notifies every mounted reader through a window event. Unknown or
 * unreadable stored values fall back to the default instead of failing.
 */
import { useCallback, useEffect, useState } from 'react';

export type Preferences = {
  /** Colour scheme; `system` follows prefers-color-scheme. */
  theme: 'light' | 'dark' | 'system';
  /** Completed turns: tool groups collapsed (compact) or open (expanded). */
  density: 'compact' | 'expanded';
  /** What Enter does while a run is active; Cmd/Ctrl+Enter does the other. */
  enterWhileRunning: 'queue' | 'steer';
};

export const PREFERENCE_DEFAULTS: Preferences = {
  theme: 'system',
  density: 'compact',
  enterWhileRunning: 'queue',
};

const ALLOWED: { [K in keyof Preferences]: readonly Preferences[K][] } = {
  theme: ['light', 'dark', 'system'],
  density: ['compact', 'expanded'],
  enterWhileRunning: ['queue', 'steer'],
};

const STORAGE_KEY: { [K in keyof Preferences]: string } = {
  // `app-theme` predates this module; keep reading what users already saved.
  theme: 'app-theme',
  density: 'pref-density',
  enterWhileRunning: 'pref-enter-while-running',
};

const EVENT = 'app-preference-change';

export function readPreference<K extends keyof Preferences>(key: K, storage: Pick<Storage, 'getItem'> | null = safeStorage()): Preferences[K] {
  try {
    const raw = storage?.getItem(STORAGE_KEY[key]);
    return (ALLOWED[key] as readonly string[]).includes(String(raw)) ? (raw as Preferences[K]) : PREFERENCE_DEFAULTS[key];
  } catch {
    return PREFERENCE_DEFAULTS[key];
  }
}

export function writePreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
  try {
    safeStorage()?.setItem(STORAGE_KEY[key], value);
  } catch {
    /* private mode / blocked storage: the preference just does not persist */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT, { detail: { key, value } }));
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function usePreference<K extends keyof Preferences>(key: K): [Preferences[K], (value: Preferences[K]) => void] {
  const [value, setValue] = useState<Preferences[K]>(() => readPreference(key));
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ key: string }>).detail;
      if (detail?.key === key) setValue(readPreference(key));
    };
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, [key]);
  const set = useCallback((next: Preferences[K]) => writePreference(key, next), [key]);
  return [value, set];
}
