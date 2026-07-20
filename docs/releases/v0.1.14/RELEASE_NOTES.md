# Magi Desktop v0.1.14

This is the first release from the standalone `EDLee01/magi-desktop` repository.

## Highlights

- Electron desktop workbench with project and task history.
- Desktop-owned Magi headless service that starts automatically.
- OpenAI-compatible and Anthropic-compatible provider configuration with model discovery.
- Model and permission-mode switching from the composer.
- Image attachments for vision-capable models.
- Restored Markdown formatting for historical conversations.
- **Magi Familiar**: a draggable magic-hat desktop companion with edge snapping, auto-hide, status animations, a mini task composer, streamed short responses, approval reminders, and exact conversation hand-off to the main window.

## Windows installer

- Platform: Windows x64
- Runtime: bundled Node.js 24.18.0 and Magi headless service
- Installer type: NSIS, per-user installation
- Signing: unsigned internal test build; Windows SmartScreen may show an unknown-publisher warning

SHA-256:

```text
a302247d33575a736243131a4d8d605732bb06b3c1091d6ff3a747b5baf424bf  Magi-0.1.14-Setup-x64.exe
```
