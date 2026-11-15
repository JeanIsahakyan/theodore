#!/bin/sh
# Renders the app's icons from mobile/assets/src (Theodore's logo, the same
# glasses as apps/desktop/icons/src/icon.svg) with resvg (gradients render
# right; ImageMagick's own SVG reader blackens them) and ImageMagick for the
# no-alpha flatten. Run after changing a source; commit the PNGs.
set -eu
cd "$(dirname "$0")/../assets"
svg() { npx -y @resvg/resvg-js-cli@2.6.2-beta.1 --fit-width "$2" "src/$1.svg" "$3" >/dev/null; }
# iOS / store: full-bleed, no alpha (the OS masks the corners).
svg icon 1024 icon.png
magick icon.png -background '#3F86D6' -flatten -alpha off icon.png
svg android-icon-background 1024 android-icon-background.png
svg android-icon-foreground 1024 android-icon-foreground.png
svg android-icon-monochrome 1024 android-icon-monochrome.png
# Android notification icon: white on transparent, 96 px.
svg android-icon-monochrome 96 notification-icon.png
# The rounded tile, as the desktop shows it: splash, sign-in, favicon.
svg logo 1024 splash-icon.png
svg logo 512 logo.png
svg logo 48 favicon.png
