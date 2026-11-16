/**
 * Android 12+: the Tailwind tokens (src/global.css) take Material You's
 * roles, the same mapping `usePalette()` uses (`ui/materialPalette`), so
 * `bg-background`, `bg-primary` and the Compose controls agree. Below 12 the
 * CSS tokens stay; the accent is the app's either way.
 *
 * | Token | Material role |
 * | --- | --- |
 * | background | surface |
 * | card, sidebar | surfaceContainerLow |
 * | muted, secondary, accent | surfaceContainerHigh |
 * | foreground / muted-foreground | onSurface / onSurfaceVariant |
 * | border | outlineVariant |
 * | primary / primary-foreground | primary / onPrimary |
 * | danger | error |
 */
import {
  getMaterialColors,
  isDynamicColorAvailable,
} from '@expo/ui/jetpack-compose';
import { Uniwind } from 'uniwind';

export function applyThemeVars(): void {
  if (!isDynamicColorAvailable) return;
  for (const scheme of ['light', 'dark'] as const) {
    const m = getMaterialColors({ scheme });
    Uniwind.updateCSSVariables(scheme, {
      '--app-background': m.surface,
      '--app-card': m.surfaceContainerLow,
      '--app-sidebar': m.surfaceContainerLow,
      '--app-muted': m.surfaceContainerHigh,
      '--app-secondary': m.surfaceContainerHigh,
      '--app-accent': m.surfaceContainerHighest,
      '--app-user-bubble': m.surfaceContainerHigh,
      '--app-foreground': m.onSurface,
      '--app-muted-foreground': m.onSurfaceVariant,
      '--app-border': m.outlineVariant,
      '--app-primary': m.primary,
      '--app-primary-foreground': m.onPrimary,
      '--app-danger': m.error,
    });
  }
}
