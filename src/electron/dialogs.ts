import { BrowserWindow, dialog, shell } from "electron"
import type { OpenDialogOptions, SaveDialogOptions } from "electron"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { readRendererConfig } from "./config.js"
import type { PickFileOptions, SaveBinaryRequest, SaveTextRequest } from "./ipcTypes.js"
import { pickedFile } from "./pickedFile.js"

/**
 * Opens a native file picker and maps selected paths into renderer-safe metadata.
 *
 * @param window Window that should own the dialog, if one is available.
 * @param options Validated dialog title, filters, and multi-select flag.
 * @returns Metadata for every selected file, or an empty array when cancelled.
 */
export async function pickFiles(window: BrowserWindow | undefined, options: PickFileOptions) {
	const dialogOptions: OpenDialogOptions = {
		title: options.title,
		properties: options.multiple ? ["openFile", "multiSelections"] : ["openFile"],
		filters: options.filters
	}
	const result = window ? await dialog.showOpenDialog(window, dialogOptions) : await dialog.showOpenDialog(dialogOptions)

	if (result.canceled) {
		return []
	}

	return Promise.all(result.filePaths.map(pickedFile))
}

/**
 * Opens the app config directory in the platform file manager.
 *
 * @returns A promise that rejects when the shell refuses to open the folder.
 */
export async function openConfigFolder() {
	const config = await readRendererConfig()
	const folder = path.dirname(config.configPath)
	await mkdir(folder, { recursive: true })
	const error = await shell.openPath(folder)
	if (error) {
		throw new Error(error)
	}
}

/**
 * Saves renderer log text through a native save dialog.
 *
 * @param window Window that should own the dialog, if one is available.
 * @param request Validated text-save request.
 * @returns Saved path, or undefined when cancelled.
 */
export async function saveText(window: BrowserWindow | undefined, request: SaveTextRequest) {
	const dialogOptions: SaveDialogOptions = {
		title: "Save Log",
		defaultPath: request.defaultName,
		filters: [
			{ name: "Text files", extensions: ["txt"] },
			{ name: "All files", extensions: ["*"] }
		]
	}
	const result = window ? await dialog.showSaveDialog(window, dialogOptions) : await dialog.showSaveDialog(dialogOptions)

	if (result.canceled || !result.filePath) {
		return undefined
	}

	await writeFile(result.filePath, request.content, "utf8")
	return result.filePath
}

/**
 * Saves binary ICF output through a native save dialog.
 *
 * @param window Window that should own the dialog, if one is available.
 * @param request Validated binary-save request.
 * @returns Saved path, or undefined when cancelled.
 */
export async function saveBinary(window: BrowserWindow | undefined, request: SaveBinaryRequest) {
	const dialogOptions: SaveDialogOptions = {
		title: "Save ICF",
		defaultPath: request.defaultName,
		filters: [{ name: "All files", extensions: ["*"] }]
	}
	const result = window ? await dialog.showSaveDialog(window, dialogOptions) : await dialog.showSaveDialog(dialogOptions)

	if (result.canceled || !result.filePath) {
		return undefined
	}

	const content = request.content instanceof ArrayBuffer ? Buffer.from(request.content) : Buffer.from(request.content)
	await writeFile(result.filePath, content)
	return result.filePath
}
