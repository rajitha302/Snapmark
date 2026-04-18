# Snapmark

**The screenshot annotator for AI chat.** Clipboard in, clipboard out — works with Claude Code, GitHub Copilot Chat, Cursor, Gemini Code Assist, Continue, Cline, and anything else that accepts pasted images. No integration, no configuration, no telemetry.

## Why Snapmark?

Every code-editor image tool solves a different problem than this one. Snapmark is the only one built for the "show a screenshot to an LLM" workflow:

- **Redact before sending.** Drag over an API key, password, or customer name — pixelated in place, right in the image. Privacy-preserving by default, not as an afterthought.
- **Numbered step markers.** Drop `1`, `2`, `3` circles on a UI flow so the model reads the sequence instead of guessing.
- **Auto-compression on copy.** Retina 5K screenshots get downscaled to a configurable max dimension before hitting the clipboard, so you don't burn vision-model tokens or upload time on pixels no one needs.

Other extensions either save to disk (Markdown Paste), render code to images (CodeSnap, Polacode), or give you a full Photoshop-style editor on files (Luna Paint). None of them touch the clipboard → annotate → paste into AI chat loop.

## Install

```bash
code --install-extension snapmark-1.0.0.vsix
```

### Prerequisites

| OS | Requirement |
|---|---|
| **macOS** | None. Uses built-in `osascript`. |
| **Windows** | None. Uses built-in PowerShell (Windows 7+). |
| **Linux (X11)** | `sudo apt install xclip` (or `dnf install xclip`). Prompted on first use if missing. |
| **Linux (Wayland)** | `sudo apt install wl-clipboard` (or `dnf install wl-clipboard`). Prompted on first use if missing. |

Linux doesn't ship with a universal clipboard-image tool, so this is unavoidable. macOS and Windows users install and go.

## Use

1. Copy an image to your clipboard (`⌃⇧⌘4` on macOS, `Win+Shift+S` on Windows, or any screenshot tool).
2. The pencil in the VS Code status bar turns into a warm-yellow "Annotate" label within ~2.5s.
3. Click it, or hit `⌘⇧A` (macOS) / `Ctrl+Shift+A` (Windows/Linux).
4. Annotate with: pen, arrow, rectangle, ellipse, text, highlight, crop, **redact**, **numbered steps**. Pick colors and stroke sizes from the toolbar.
5. Click **Copy** (or `⌘⏎`). The annotated image replaces the clipboard contents, downscaled if it exceeded the max-dimension setting.
6. `⌘V` into any AI chat.

### Keyboard shortcuts (inside editor)

| Key | Action |
|-----|--------|
| `V` | Select |
| `P` | Pen |
| `A` | Arrow |
| `R` | Rectangle |
| `T` | Text |
| `C` | Crop |
| `B` | Redact (pixelate) |
| `N` | Numbered step |
| `⌘Z` / `⌘⇧Z` | Undo / Redo |
| `⌘⏎` | Copy |
| `Esc` | Close |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `snapmark.clipboardDetection` | `true` | Watch the clipboard and highlight the status-bar item when a screenshot is detected. |
| `snapmark.maxDimension` | `1920` | Max pixel dimension (width or height) when copying to clipboard. Set to `0` to disable. |

## Platform support

| Platform | Status |
|----------|--------|
| macOS | ✅ Zero-dep (`osascript`) |
| Windows | ✅ Zero-dep (PowerShell) |
| Linux X11 | ✅ Requires `xclip` |
| Linux Wayland | ✅ Requires `wl-clipboard` |

## Privacy

Snapmark is 100% local:
- No network calls
- No telemetry
- No accounts
- No cloud
- Nothing leaves your machine — including the detection probe, which only asks the OS "is there an image on the clipboard?" without reading the pixels.

We only read from and write to your system clipboard, via standard OS commands (`osascript` on macOS, PowerShell on Windows, `xclip` / `wl-clipboard` on Linux).

## License

MIT
