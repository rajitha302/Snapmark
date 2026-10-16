# Changelog

## 1.0.1 — 2026-10-16

- New look: frosted-glass toolbars float over the screenshot, with tools down the left edge, upload, Copy and Close at the top right, and colours, widths and undo at the bottom. When transparency is reduced in system settings, the bars are solid. Copy and other main buttons use Snapmark's gold, matching the website, over a dark background with a faint golden glow. Drawing colours are Apple's system palette.
- Fixed the screenshot staying invisible after opening (or after zooming or resizing) on Retina/HiDPI screens until you drew something.
- Redact now covers the area with a solid block. Pixelated text can sometimes be reconstructed, so pixelation was not a safe way to hide secrets.
- Crop and redact no longer extend past the area you drew when you drag beyond the image edge.
- Pressing the annotate shortcut while the editor is open no longer discards your annotations. It only loads a new image if you copied one since.
- Undo history no longer stores a copy of the screenshot per step, which cut memory use and made undo faster on large images.
- `Cmd/Ctrl + Enter` with no image loaded no longer overwrites your clipboard with a blank image.
- Windows: clipboard detection uses one background PowerShell process instead of starting a new one every 2.5 seconds.
- Linux: clipboard tool detection no longer runs on every poll.
- New comment tool (`M`): click a spot to drop a Figma-style speech bubble that points at it, then type. "Comment" shows as a placeholder until you type, and a comment you leave empty is dismissed. It uses the current colour, the width setting controls the text size, you can double-click to edit it again, and it flips direction near the right and top edges.
- Tools can be reordered: drag a tool along the toolbar, or focus it and press Alt+Arrow. The order is saved and survives restarts.
- The toolbar can be moved: drag its grip (or focus it and use the arrow keys) to dock it on the left, right, top or bottom edge. While dragging, a glowing outline previews exactly where it will land. The position is remembered.
- The tool you pick stays selected until you close the editor. Text and Comment no longer switch back to Select after each use. With those tools, clicking away finishes what you're typing, clicking an existing text or comment edits or moves it, and Delete removes the selected one.
- Blue is now the default colour.
- Right-click menu, styled to match the editor. On an annotation: Edit text, Duplicate, Bring to front, Send to back, Delete. Anywhere: Undo, Redo, Copy image, Download PNG (full resolution, saved where you choose), Fit to window, Clear annotations. While you're typing, the normal text menu still appears.
- Delete button in the bottom toolbar, active while something is selected.
- Fixed shapes drawn by dragging (rectangle, ellipse, highlight) being clickable only near the corner where you started drawing.
- Picking a size resizes whatever is selected: line width for strokes and shapes, properly sized arrowheads for arrows, text size for text and comments, and the whole marker for step markers. Text now follows the size setting too (Medium is unchanged).
- Picking a colour recolours whatever is selected: pen strokes, arrows, shapes, highlights, text, comments and step markers, including several at once. Redactions stay black. Step markers and comments switch to dark text on light colours so they stay readable.
- New Upload button next to Copy for opening a different image partway through. It replaces the current image and its annotations.
- New two-way arrow tool (`D`), for showing a relationship or a measurement between two points.
- New shortcuts: `E` for ellipse, `H` for highlight.
- New Measure tool (`U`) for UI work: drag between two points to label the distance in pixels. Lines snap to horizontal or vertical (hold Shift to force it), and a magnifier shows the exact pixels under the pointer. On Retina screenshots the label shows CSS pixels: Snapmark reads the density saved in the PNG, and the `2×` button in the bottom bar corrects it when the guess is wrong.
- New Color picker (`I`): click any pixel to label its hex value (e.g. `#1F6FEB`), with the same magnifier while you aim.
- New Spotlight (`S`): drag over the part that matters and everything else is dimmed. Annotations stay bright, and several spotlights can overlap.
- Compare two images: Upload → Compare with another image (or drop a second image onto the "Compare" target) places it beside the current one, labelled "Actual" and "Expected", for "make it look like this" requests. Upload → Replace image works as before.
- To keep the toolbar compact, related tools share a slot: arrow and two-way arrow, rectangle and ellipse, highlight and spotlight. The slot shows the last tool used; hover over it to see the others (or click it again, or right-click it). Shortcuts still select each tool directly.
- First-run tips: the first time you open the editor, four short tips point at the toolbar, the style bar, the right-click menu and Copy. Skip them at any point (or press Esc); right-click → Show tips brings them back.
- Fixed an error logged when VS Code shut the extension down.
- Renamed to "SnapMark - Image Editor" in the Extensions view and Marketplace. The extension ID (`RajithaDisanayaka.snapmark`) is unchanged, so existing installs update normally.

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
