import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { usePreference } from './preferences';

export type ThemeMode = 'dark' | 'light';

interface ThemeContextValue {
  /** The scheme actually applied (the `system` preference resolved). */
  theme: ThemeMode;
  toggleTheme: (next?: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  toggleTheme: () => {},
});

function systemTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * Applies the colour-scheme preference (light / dark / follow the system) as
 * `[data-theme]` on <html>; dark is the token default, so only light is set.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = usePreference('theme');
  const [system, setSystem] = useState<ThemeMode>(systemTheme);
  const theme: ThemeMode = preference === 'system' ? system : preference;

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!media) return;
    const onChange = () => setSystem(media.matches ? 'light' : 'dark');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (theme === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
  }, [theme]);

  function toggleTheme(next?: ThemeMode) {
    setPreference(next || (theme === 'light' ? 'dark' : 'light'));
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): [ThemeMode, (next?: ThemeMode) => void] {
  const ctx = useContext(ThemeContext);
  return [ctx.theme, ctx.toggleTheme];
}
