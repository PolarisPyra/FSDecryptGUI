import { BrowserWindow, dialog, shell } from "electron"
import type { OpenDialogOptions, SaveDialogOptions } from "electron"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { readRendererConfig } from "./config.js"
import type { PickFileOptions, SaveBinaryRequest, SaveTextRequest } from "./ipcTypes.js"
import { pickedFile } from "./pickedFile.js"

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

export async function openConfigFolder() {
	const config = await readRendererConfig()
	const folder = path.dirname(config.configPath)
	await mkdir(folder, { recursive: true })
	const error = await shell.openPath(folder)
	if (error) {
		throw new Error(error)
	}
}

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
