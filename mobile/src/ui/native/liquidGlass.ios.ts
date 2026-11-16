/**
 * iOS: whether Liquid Glass is drawn. `isLiquidGlassAvailable()` is false
 * below iOS 26, on a build made with an Xcode before 26, and when the app
 * opts out (`UIDesignRequiresCompatibility`). Read once: it can't change
 * while the app runs. Reduce Transparency is the system's business (glass
 * turns frosted by itself).
 */
import { isLiquidGlassAvailable } from 'expo-glass-effect';

function available(): boolean {
  try {
    return isLiquidGlassAvailable();
  } catch {
    // A build without the native module: the pre-26 look.
    return false;
  }
}

export const liquidGlass: boolean = available();
