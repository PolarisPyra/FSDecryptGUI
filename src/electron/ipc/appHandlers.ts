import { Notification, clipboard, ipcMain } from "electron"

import { saveBinary, saveText } from "../dialogs.js"
import { validateNotifyRequest, validateSaveBinaryRequest, validateSaveTextRequest } from "../ipcValidation.js"
import { windowForEvent } from "./window.js"

/** Registers app-level IPC for clipboard, save dialogs, and desktop notifications. */
export function registerAppHandlers() {
	ipcMain.handle("app:copyText", async (_event, text: unknown) => {
		clipboard.writeText(validateSaveTextRequest({ defaultName: "clipboard.txt", content: text }).content)
	})

	ipcMain.handle("app:saveText", async (event, request: unknown) => saveText(windowForEvent(event), validateSaveTextRequest(request)))

	ipcMain.handle("app:saveBinary", async (event, request: unknown) => saveBinary(windowForEvent(event), validateSaveBinaryRequest(request)))

	ipcMain.handle("app:notify", async (event, request: unknown) => {
		const notification = validateNotifyRequest(request)
		const window = windowForEvent(event)
		if (window && !window.isFocused()) {
			window.flashFrame(true)
			window.once("focus", () => window.flashFrame(false))
		}

		if (Notification.isSupported()) {
			new Notification({
				title: notification.title,
				body: notification.body
			}).show()
		}
	})
}
