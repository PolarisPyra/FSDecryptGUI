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

## Developer structure

The renderer is split by responsibility. Keep code in the lowest layer that can
own it:

- `src/renderer/base/common/` contains framework-independent utilities. Put
  generic formatting, path, and cancellation helpers here.
- `src/renderer/app/common/` contains app-level types and constants shared
  by the app. Put mode definitions and shared model types here.
- `src/renderer/app/browser/` contains React/browser view composition.
  Components in this folder should render state and call props; avoid putting
  extraction, filesystem, or selection-analysis workflows here.
- `src/renderer/app/services/` contains renderer-side application
  services. Put local storage, selection analysis, extraction orchestration,
  progress writers, and IPC-facing workflows here.
- `src/renderer/App.tsx` is the app controller. It owns high-level state,
  connects services to the view, and should stay small enough to scan quickly.
- `src/renderer/electron-api.ts` is the typed preload API boundary. Renderer
  code should call Electron through this file instead of reaching for globals
  directly.

Electron main-process code lives in `src/electron/`:

- `main.ts` owns windows, menus, dialogs, notifications, safe output-path
  handling, and IPC handlers.
- `preload.cjs` exposes the minimal IPC bridge to the renderer.
- `config.ts` owns `config.yaml` loading, writing, and conversion into renderer
  config.

Core decrypt and filesystem parsing code lives in `src/fsdecrypt/`. Keep it UI
agnostic: it should work from byte sources, report progress through callbacks,
and avoid Electron or React imports.

### Important workflows

- Selection metadata is built in
  `src/renderer/app/services/selectionService.ts`. Use this for APP,
  OPTION, and VHD chain grouping and warnings.
- Selection queue mutation, input-folder partitioning, mode job counts, and
  blocking-warning summaries are owned by
  `src/renderer/app/services/selectionQueue.ts`.
- Exports are run through
  `src/renderer/app/services/extractionService.ts`. Batch completion
  notifications are emitted after the full batch finishes, not after each job.
- Extraction batch planning, progress lifecycle, history records, cancellation,
  and completion notifications are owned by
  `src/renderer/app/services/extractionBatch.ts`.
- OPTION-specific nested OPTION and VHD expansion is owned by
  `src/renderer/app/services/optionExtraction.ts`.
- File writing and progress accounting are handled by
  `src/renderer/app/services/extractionWriter.ts`, which writes through
  Electron IPC so the renderer never writes to disk directly.
- Export history is persisted in
  `src/renderer/app/services/historyStorage.ts`.
- Electron main-process IPC wiring stays in `src/electron/main.ts`; reusable
  adapters live in `src/electron/chrome.ts`, `src/electron/dialogs.ts`, and
  `src/electron/fileSystem.ts`.

### Change guidelines

- Keep React components mostly presentational. Pass callbacks in from
  `App.tsx`; move non-trivial behavior into services.
- Keep shared types in `app/common/appTypes.ts`; do not duplicate
  shape definitions across browser and service files.
- Keep generic helpers out of services. If a helper has no app state and no
  Electron dependency, it probably belongs in `base/common/`.
- Validate with `pnpm typecheck` and `pnpm build` after renderer changes.
- Validate packaging-affecting changes with `pnpm dist:linux` on Linux.

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
