# Changelog

## 1.0.1 — 2026-10-16

- New look: frosted-glass toolbars float over the screenshot, with tools down the left edge, upload, Copy and Close at the top right, and colours, widths and undo at the bottom. When transparency is reduced in system settings, the bars are solid. Colours are now Apple's system palette.
- Fixed the screenshot staying invisible after opening (or after zooming or resizing) on Retina/HiDPI screens until you drew something.
- Redact now covers the area with a solid block. Pixelated text can sometimes be reconstructed, so pixelation was not a safe way to hide secrets.
- Crop and redact no longer extend past the area you drew when you drag beyond the image edge.
- Pressing the annotate shortcut while the editor is open no longer discards your annotations. It only loads a new image if you copied one since.
- Undo history no longer stores a copy of the screenshot per step, which cut memory use and made undo faster on large images.
- `Cmd/Ctrl + Enter` with no image loaded no longer overwrites your clipboard with a blank image.
- Windows: clipboard detection uses one background PowerShell process instead of starting a new one every 2.5 seconds.
- Linux: clipboard tool detection no longer runs on every poll.
- New comment tool (`M`): click a spot to drop a Figma-style speech bubble that points at it, then type. It uses the current colour, the width setting controls the text size, you can double-click to edit it again, and it flips direction near the right and top edges.
- The toolbar can be moved: drag its grip (or focus it and use the arrow keys) to dock it on the left, right, top or bottom edge. The position is remembered.
- New upload button next to Copy for opening a different image partway through. It replaces the current image and its annotations.
- New two-way arrow tool (`D`), for showing a relationship or a measurement between two points.
- New shortcuts: `E` for ellipse, `H` for highlight.

## 1.0.0 — 2026-04-18

First release.

- Pen, arrow, rectangle, ellipse, text, highlight, and crop tools
- Redact tool for hiding sensitive parts of a screenshot
- Numbered step markers (1, 2, 3) for explaining UI flows
- Undo, redo, clear
- Zoom with Cmd/Ctrl + scroll or a trackpad pinch
- Automatic resizing on copy so large screenshots don't slow down uploads
- Status-bar pencil lights up when you copy a new image
- Drag-and-drop, paste, or file picker for loading an image into the editor
- Works on macOS, Windows, and Linux
