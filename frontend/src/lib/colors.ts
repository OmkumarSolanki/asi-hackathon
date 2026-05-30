// Single source of truth for option colors — used by MapView lines AND BriefingPanel swatches.

import type { RouteOption } from './api'

export const OPTION_COLORS = ['#00E37A', '#00D4FF', '#FFB800', '#A78BFA'] as const
export const DIRECT_COLOR = '#FFFFFF'

export function optionColor(option: RouteOption, viableSorted: RouteOption[]): string {
  if (option.id === 'direct') return DIRECT_COLOR
  // index among non-direct viable options
  const detours = viableSorted.filter((o) => o.id !== 'direct')
  const i = detours.findIndex((o) => o.id === option.id)
  if (i < 0) return OPTION_COLORS[0]
  return OPTION_COLORS[i % OPTION_COLORS.length]
}
