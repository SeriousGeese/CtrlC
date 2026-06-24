# CtrlC

Cross-platform clipboard manager with hotkey-triggered popup.

Built by [Serious Geese, LLC](https://seriousgeese.dev)

## Features

- **Auto-save** — every clipboard change is captured automatically
- **Hotkey popup** — press `Ctrl + `` ` to open the clipboard history
- **Search** — filter clips by content
- **Quick paste** — press `1`-`5` to copy the first five clips instantly
- **Plain text paste** — `Ctrl + Shift + V` strips HTML from rich text
- **Multi-format** — supports text, HTML, images, and binary content
- **Deduplication** — same content is only stored once
- **30-day retention** — clips older than 30 days are auto-cleaned
- **Configurable** — hotkey, history depth, and retention via TOML config
- **System tray** — always shows the app is running

## Installation

```bash
npm install
npm start
```

## Configuration

Config is stored at `~/.CtrlC/config.toml`:

```toml
hotkey = "CommandOrControl+Backquote"
historyDepth = 100
retentionDays = 30
saveImages = true
saveHtml = true
saveBinary = true
autoStart = false
```

Override the data directory with `CTRLC_DATA_DIR` environment variable.

## Clipboard Data

All clips are stored in `~/.CtrlC/` with:
- `.config/cutc.db` — SQLite database (clips metadata)
- `Clips/` — image and binary attachments

## Platform Notes

### Linux (Wayland)
Global hotkeys require a native sidecar binary on Wayland. The `electron-global-hotkey` module handles this, but some compositors may need additional configuration.

### macOS
First launch requires Accessibility and Clipboard permissions in System Settings.

## License

MIT — see [LICENSE](LICENSE)
