import { app, BrowserWindow } from "electron"

import { createWindow, installMenu, installSecurityHandlers } from "./chrome.js"
import { closeInputHandles } from "./fileSystem.js"
import { outputFolders } from "./folderManager.js"
import { chooseInputFolder, chooseOutputFolder } from "./folderSelection.js"
import { registerIpcHandlers } from "./ipc/index.js"

app.setName("fsdecryptGUI")

// Every renderer-originating value is treated as untrusted and validated before
// reaching dialog, filesystem, config, or crypto adapters.
registerIpcHandlers()

app.whenReady().then(() => {
	installSecurityHandlers()
	installMenu({ chooseInputFolder, chooseOutputFolder })
	return createWindow()
})

app.on("before-quit", () => {
	void closeInputHandles()
	void outputFolders.closeAllOpenFiles()
})

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit()
	}
})

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) {
		void createWindow()
	}
})
