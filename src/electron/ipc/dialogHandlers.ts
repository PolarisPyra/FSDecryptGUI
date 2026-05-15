import { ipcMain } from "electron"

import { pickFiles } from "../dialogs.js"
import { chooseInputFolder, chooseOutputFolder } from "../folderSelection.js"
import { validatePickFileOptions } from "../ipcValidation.js"
import { windowForEvent } from "./window.js"

/** Registers native dialog IPC used by the renderer's selection controls. */
export function registerDialogHandlers() {
	ipcMain.handle("dialog:pickFiles", async (event, options) => pickFiles(windowForEvent(event), validatePickFileOptions(options)))

	ipcMain.handle("dialog:selectOutputFolder", async event => {
		const window = windowForEvent(event)
		return window ? chooseOutputFolder(window) : undefined
	})

	ipcMain.handle("dialog:selectInputFolder", async event => {
		const window = windowForEvent(event)
		return window ? chooseInputFolder(window) : undefined
	})
}
