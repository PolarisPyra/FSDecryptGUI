# fsdecryptGUI

Desktop Electron GUI for extracting fscrypt APP, Option, and VHD chain contents.

## Use

```sh
pnpm install
pnpm dev
```

For a packaged desktop app directory:

```sh
pnpm package
```

For distributable installers:

```sh
pnpm dist
```

## Notes

- `Base APP` decrypts an APP/OS container, finds the internal VHD, mounts the NTFS view, and extracts files.
- `Option` decrypts an `.opt` container and extracts the exFAT contents.
- `Merge APPs` accepts APP and VHD layers, merges the chain, and extracts the resulting NTFS contents.
- Key files may be 16 bytes or 32 bytes. Built-in keys are used when no key file is selected.
- Output is written through Electron's main process into the selected output folder.
- Select the output folder from `File > Select Output Folder...`.
- The selected output folder and key file path are saved in `config.yaml` under Electron's per-OS app config directory:
  - Linux: `~/.config/fsdecryptGUI/config.yaml`
  - macOS: `~/Library/Application Support/fsdecryptGUI/config.yaml`
  - Windows: `%APPDATA%\\fsdecryptGUI\\config.yaml`
