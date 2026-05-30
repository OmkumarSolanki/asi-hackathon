/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'var(--c-bg)',
          raised: 'var(--c-bg-raised)',
          panel: 'var(--c-bg-panel)',
          hairline: 'var(--c-hairline)',
          divider: 'var(--c-bg-divider)',
        },
        ink: {
          DEFAULT: 'var(--c-ink)',
          muted: 'var(--c-ink-muted)',
          dim: 'var(--c-ink-dim)',
          ghost: 'var(--c-ink-ghost)',
        },
        cyan: {
          DEFAULT: '#00D4FF',
          deep: '#0091B3',
          glow: 'rgba(0, 212, 255, 0.16)',
        },
        amber: {
          DEFAULT: '#FFB800',
          deep: '#B38200',
          glow: 'rgba(255, 184, 0, 0.16)',
        },
        red: {
          DEFAULT: '#FF3B30',
          deep: '#B22A22',
          glow: 'rgba(255, 59, 48, 0.16)',
        },
        ok: {
          DEFAULT: '#00E37A',
          deep: '#009E54',
          glow: 'rgba(0, 227, 122, 0.16)',
        },
      },
      fontFamily: {
        sans: ['"Geist Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono Variable"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '14px', letterSpacing: '0.04em' }],
        '3xs': ['9px', { lineHeight: '12px', letterSpacing: '0.06em' }],
      },
      letterSpacing: {
        tight: '-0.015em',
        tighter: '-0.025em',
        wide: '0.04em',
        wider: '0.08em',
      },
      boxShadow: {
        panel: '0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 60px -20px rgba(0,0,0,0.6)',
        glow: '0 0 24px rgba(0,212,255,0.18)',
        readout: 'inset 0 0 0 1px rgba(255,255,255,0.04)',
      },
      backdropBlur: {
        glass: '14px',
      },
      animation: {
        'pulse-soft': 'pulseSoft 2.4s ease-in-out infinite',
        'scan': 'scan 4s linear infinite',
        'fade-up': 'fadeUp 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards',
      },
      keyframes: {
        pulseSoft: {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
        scan: {
          '0%': { backgroundPosition: '0 0' },
          '100%': { backgroundPosition: '0 12px' },
        },
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
