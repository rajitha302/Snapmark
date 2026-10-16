# Snapmark

Annotate screenshots on your clipboard, then paste them into AI chats like Claude, Copilot, and Cursor. Runs locally.

## Use it

Copy an image. A pencil lights up in your VS Code status bar. Click it, draw on the screenshot, hit **Copy**. Paste into your chat.

If there is no image on the clipboard, click the pencil anyway. You can drag an image file in, paste one with `Cmd+V`, or pick a file from your computer. To switch to a different image partway through, or to add one to compare against, use **Upload** next to **Copy**, or drop the file onto the editor.

## Features

- Redact sensitive areas with a solid block (API keys, names, anything you don't want in the image)
- Drop numbered step markers onto UI flows
- Leave Figma-style comment bubbles that point at a spot on the screenshot
- Pen, arrow, two-way arrow, rectangle, ellipse, text, highlight, crop
- Measure distances in pixels (CSS pixels on Retina screenshots), with a magnifier for precision
- Pick a color from the screenshot and label its hex value
- Spotlight an area to dim everything else
- Compare a screenshot with a design: put a second image beside it, labelled "Actual" and "Expected"
- Related tools share a toolbar slot. Hover over it to pick another (for example, ellipse instead of rectangle)
- Zoom with `Cmd/Ctrl` + scroll or a trackpad pinch
- Move the toolbar to any edge by dragging its grip, and drag tools to reorder them. Snapmark remembers both, even after a restart
- Resize large screenshots automatically on copy
- Right-click for a menu: duplicate, bring to front, send to back, delete, undo, copy, and download the full-size PNG
- A short tour of the editor the first time you open it. Right-click → **Show tips** to see it again
- Pencil in the status bar lights up when you copy a new image

## Install

Search for **Snapmark** in the VS Code Extensions view, or run:

```bash
code --install-extension RajithaDisanayaka.snapmark
```

To install a downloaded build instead, use `code --install-extension snapmark-1.0.1.vsix`.

Linux users need `xclip` (X11) or `wl-clipboard` (Wayland). macOS and Windows work as-is.

## How to use it

1. Copy an image to your clipboard.
2. Click the pencil in the status bar, or press `Cmd+Shift+A` on macOS (`Ctrl+Shift+A` on Windows and Linux).
3. Draw on the image.
4. Click **Copy**, then paste into your AI chat with `Cmd+V`.

### Keyboard shortcuts (inside the editor)

| Key | Action |
|-----|--------|
| `V` | Select |
| `P` | Pen |
| `A` | Arrow |
| `D` | Two-way arrow |
| `R` | Rectangle |
| `E` | Ellipse |
| `H` | Highlight |
| `S` | Spotlight |
| `U` | Measure |
| `I` | Color picker |
| `T` | Text |
| `M` | Comment bubble |
| `C` | Crop |
| `B` | Redact |
| `N` | Numbered step |
| `Cmd/Ctrl + Z` | Undo |
| `Cmd/Ctrl + Shift + Z` | Redo |
| `Cmd/Ctrl + scroll` | Zoom |
| `Cmd/Ctrl + 0` | Reset zoom |
| `Cmd/Ctrl + Enter` | Copy |
| `Esc` | Close |

## Settings

| Setting | Default | What it does |
|---------|---------|--------------|
| `snapmark.clipboardDetection` | `true` | Highlights the status bar when a new image lands on your clipboard. |
| `snapmark.maxDimension` | `1920` | Longest edge (in pixels) when copying. Set to `0` to keep the original size. |

## Privacy

Snapmark runs entirely on your machine. No network calls, no telemetry, no accounts. It only reads and writes your clipboard.

## License

MIT
