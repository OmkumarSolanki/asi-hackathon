import { useEffect } from 'react'
import { create } from 'zustand'

export type Theme = 'dark' | 'light'

type ThemeState = {
  theme: Theme
  setTheme: (t: Theme) => void
  toggleTheme: () => void
}

function initial(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const saved = localStorage.getItem('wx-advisory-theme') as Theme | null
  if (saved === 'dark' || saved === 'light') return saved
  return 'dark'
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: initial(),
  setTheme: (t) => {
    localStorage.setItem('wx-advisory-theme', t)
    set({ theme: t })
  },
  toggleTheme: () => {
    const next: Theme = get().theme === 'dark' ? 'light' : 'dark'
    localStorage.setItem('wx-advisory-theme', next)
    set({ theme: next })
  },
}))

export function useApplyTheme() {
  const theme = useTheme((s) => s.theme)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])
}
