import { BrowserWindow, type IpcMainInvokeEvent } from "electron"

import { focusedWindow } from "../chrome.js"

/** Returns the invoking window when possible, then falls back to the active app window. */
export function windowForEvent(event: IpcMainInvokeEvent) {
	return BrowserWindow.fromWebContents(event.sender) ?? focusedWindow()
}
