# Magi Desktop

Electron + React desktop workbench for the Magi headless service.
Its desktop-owned daemon defaults to `127.0.0.1:8766`, leaving `8765` available
for an existing CLI or older Magi service. It automatically moves to the next
available loopback port if `8766` is occupied.

```bash
# Run from the repository root so dist/cli.js is available.
npm run desktop:dev
```

The renderer is sandboxed and has no Node access. Add privileged behavior in
`src/main`, expose only narrow methods through `src/preload`, and keep shared
serializable contracts in `src/shared/contracts.ts`.

See [`../docs/desktop.md`](../docs/desktop.md) for architecture and verification.

## Windows test installer

Build the Windows x64 NSIS installer from macOS or Windows:

```bash
npm run package:win
```

The build downloads the latest official Node.js 24 Windows x64 runtime, verifies
its SHA-256 checksum, installs Windows production dependencies in an isolated
staging directory, and bundles both the runtime and Magi headless service into
the installer. Testers do not need to install Node.js separately.

Artifacts are written to `release/`, with the installer named like
`Magi-0.1.13-Setup-x64.exe`. Internal test builds are unsigned, so Windows
SmartScreen may show an unknown-publisher warning until a code-signing
certificate is configured.
