import { ipcMain } from "electron"

import { readRendererConfig, updateConfig } from "../config.js"
import { openConfigFolder } from "../dialogs.js"
import { validateConfigPatch } from "../ipcValidation.js"

/** Registers config IPC for reading, updating, and opening the YAML config folder. */
export function registerConfigHandlers() {
	ipcMain.handle("config:read", async () => readRendererConfig())
	ipcMain.handle("config:update", async (_event, patch: unknown) => updateConfig(validateConfigPatch(patch)))
	ipcMain.handle("config:openFolder", async () => openConfigFolder())
}
