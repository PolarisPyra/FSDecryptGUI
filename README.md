# fsdecryptGUI

Desktop Electron GUI for extracting fscrypt APP, Option, and VHD chain contents.

## Use

```sh
corepack enable
corepack prepare pnpm@10.18.0 --activate
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

## Releases

GitHub Actions builds release installers automatically when `package.json` gets
a new `version` on `main`.

```sh
pnpm version patch
git push --follow-tags
```

The release workflow builds Linux AppImage, macOS DMG, and Windows NSIS
installers on native GitHub-hosted runners, then uploads them to the GitHub
Release named `v<package version>`. The workflow can also be run manually from
the Actions tab for the current `package.json` version.

## Notes

- `Base` decrypts an APP/OS container, finds the internal VHD, mounts the NTFS view, and extracts files.
- `Option` decrypts an `.opt` container and extracts the exFAT contents.
- `Merge` accepts APP and VHD layers, merges the chain, and extracts the resulting NTFS contents.
- Key files may be 16 bytes or 32 bytes. Built-in keys are used when no key file is selected.
- Output is written through Electron's main process into the selected output folder.
- Select the output folder from `File > Select Output Folder...`.
- The selected output folder and key file path are saved in `config.yaml` under Electron's per-OS app config directory:
  - Linux: `~/.config/fsdecryptGUI/config.yaml`
  - macOS: `~/Library/Application Support/fsdecryptGUI/config.yaml`
  - Windows: `%APPDATA%\\fsdecryptGUI\\config.yaml`

## Troubleshooting

### `Electron failed to install correctly`

This means Electron's package install script did not run, so the desktop runtime
binary was not downloaded into `node_modules`. The repository allows Electron's
build script for pnpm installs, but an existing install can still be repaired
with:

```sh
pnpm rebuild electron
pnpm dev
```

If the install was created before that approval was present, reinstall once:

```sh
rm -rf node_modules
pnpm install
pnpm dev
```

### `ENOENT: no such file or directory, uv_cwd`

This is a pnpm/Node startup error that happens before the app is loaded. It means
the terminal's current folder was deleted, moved, or renamed while the terminal
was still open.

Open a new terminal, then enter the project from a real existing folder:

```sh
cd ~
test -d ~/Downloads/FSDecryptGUI/FSDecryptGUI-main
cd ~/Downloads/FSDecryptGUI/FSDecryptGUI-main
pwd -P
pnpm install
pnpm dev
```

If the `test -d` command fails, extract or clone the project again and `cd` into
the newly created folder before running pnpm.

### Port 5173 is already in use

The dev app uses Vite on `127.0.0.1:5173`. Stop the other dev server using that
port, then run `pnpm dev` again.
