# Snapmark

Annotate screenshots on your clipboard, then paste them into AI chats like Claude, Copilot, and Cursor. Runs locally.

## Use it

Copy an image. A pencil lights up in your VS Code status bar. Click it, draw on the screenshot, hit **Copy**. Paste into your chat.

If there is no image on the clipboard, click the pencil anyway. You can drag an image file in, paste one with `Cmd+V`, or pick a file from your computer.

## Features

- Redact sensitive areas (API keys, names, anything you don't want in the image)
- Drop numbered step markers onto UI flows
- Pen, arrow, rectangle, ellipse, text, highlight, crop
- Zoom with `Cmd/Ctrl` + scroll or a trackpad pinch
- Resize large screenshots automatically on copy
- Pencil in the status bar lights up when you copy a new image

## Install

```bash
code --install-extension snapmark-1.0.0.vsix
```

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
| `R` | Rectangle |
| `T` | Text |
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
