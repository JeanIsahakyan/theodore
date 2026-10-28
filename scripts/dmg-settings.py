# dmgbuild settings for the Theodore DMG (docs/releasing.md "DMG window").
#
# Run by scripts/build-dmg.sh, never directly. dmgbuild execs this file with
# `defines` set from its -D flags:
#
#   app      path to the .app to ship
#   config   path to apps/desktop/tauri.conf.json
#
# The layout (window size, icon positions, background) is read from the
# config's bundle.macOS.dmg, so tauri.conf.json stays the one place it is
# set. dmgbuild writes the .DS_Store itself: no Finder, no AppleScript, so
# it lays the window out the same on CI as on a desk.
import json
import os
import plistlib

app = defines["app"]  # noqa: F821 (dmgbuild provides `defines`)
config_path = defines["config"]  # noqa: F821

with open(config_path, encoding="utf-8") as fp:
    dmg = json.load(fp)["bundle"]["macOS"]["dmg"]


def point(key):
    return (dmg[key]["x"], dmg[key]["y"])


app_name = os.path.basename(app.rstrip("/"))

format = "UDZO"
filesystem = "HFS+"

files = [app]
symlinks = {"Applications": "/Applications"}
hide_extensions = [app_name]

# The volume's own icon: the app's (so staging and nightly get theirs).
with open(os.path.join(app, "Contents", "Info.plist"), "rb") as fp:
    icon_file = plistlib.load(fp).get("CFBundleIconFile", "icon.icns")
if not icon_file.endswith(".icns"):
    icon_file += ".icns"
icon = os.path.join(app, "Contents", "Resources", icon_file)

# Relative to the config, as tauri resolves it (cargo tauri runs there).
# The 1x PNG; dmgbuild finds the @2x beside it and puts both in one HiDPI
# TIFF inside the DMG, so Retina screens get the sharp one.
config_dir = os.path.dirname(os.path.abspath(config_path))
background = os.path.join(config_dir, dmg["background"])

window_position = point("windowPosition") if "windowPosition" in dmg else (200, 120)
window_rect = (window_position, (dmg["windowSize"]["width"], dmg["windowSize"]["height"]))

default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
arrange_by = None
show_icon_preview = False
label_pos = "bottom"
icon_size = 128
text_size = 13

icon_locations = {
    app_name: point("appPosition"),
    "Applications": point("applicationFolderPosition"),
}
