#!/bin/sh
# The DMG window's background, rendered from its SVG source.
#
#   apps/desktop/icons/src/dmg-background.svg   source, 660 x 400 pt
#     └─▶ dmg-background.png      1x  660 x 400
#     └─▶ dmg-background@2x.png   2x  1320 x 800
#
# tauri.conf.json bundle.macOS.dmg.background points at the 1x PNG;
# scripts/build-dmg.sh (dmgbuild) picks up the @2x beside it and joins the
# two into one HiDPI TIFF inside the DMG, never in git. macOS only: AppKit's
# SVG renderer (swift), nothing to install. Run it after editing the SVG and
# commit the SVG and both PNGs.
#
# Usage: scripts/dmg-background.sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
icons="$root/apps/desktop/icons"
src="$icons/src/dmg-background.svg"

render() { # <scale> <out.png>
  swift - "$src" "$1" "$2" <<'SWIFT'
import AppKit

let args = CommandLine.arguments
guard let image = NSImage(contentsOfFile: args[1]) else {
  fatalError("can't read \(args[1])")
}
let scale = CGFloat(Double(args[2])!)
let width = Int(image.size.width * scale)
let height = Int(image.size.height * scale)
let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
// Points = the SVG's size, so the 2x file says 144 dpi and Finder lays
// it out at 660 x 400 pt.
rep.size = image.size
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
image.draw(in: NSRect(origin: .zero, size: image.size))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!
  .write(to: URL(fileURLWithPath: args[3]))
SWIFT
}

render 1 "$icons/dmg-background.png"
render 2 "$icons/dmg-background@2x.png"
echo "✓ $(cd "$icons" && echo dmg-background*.png)"
