import { BrowserWindow, dialog, shell } from "electron"
import type { OpenDialogOptions, SaveDialogOptions } from "electron"
import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { readRendererConfig, updateConfig } from "./config.js"
import type { PickFileOptions, PickedFile, SaveBinaryRequest, SaveTextRequest, ScannedInputFolder } from "./ipcTypes.js"

function sendConfig(window: BrowserWindow, config: Awaited<ReturnType<typeof readRendererConfig>>) {
	window.webContents.send("config:changed", config)
}

async function pickedFile(filePath: string): Promise<PickedFile> {
	const fileStat = await stat(filePath)
	return {
		path: filePath,
		name: path.basename(filePath),
		size: fileStat.size
	}
}

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

export async function chooseOutputFolder(window: BrowserWindow) {
	const result = await dialog.showOpenDialog(window, {
		title: "Select Output Folder",
		properties: ["openDirectory", "createDirectory"]
	})

	if (result.canceled || !result.filePaths[0]) {
		return undefined
	}

	const config = await updateConfig({ outputRoot: result.filePaths[0] })
	sendConfig(window, config)
	return config.outputRoot
}

export async function scanInputFolder(rootPath: string): Promise<ScannedInputFolder> {
	const root = path.resolve(rootPath)
	const files: ScannedInputFolder["files"] = {
		apps: [],
		options: [],
		vhds: []
	}
	const queue = [root]

	while (queue.length > 0) {
		const current = queue.shift()!
		const entries = await readdir(current, { withFileTypes: true })
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue
			const fullPath = path.join(current, entry.name)
			if (entry.isDirectory()) {
				queue.push(fullPath)
				continue
			}
			if (!entry.isFile()) continue

			const extension = path.extname(entry.name).toLowerCase()
			if (extension !== ".app" && extension !== ".opt" && extension !== ".vhd") continue

			const file = await pickedFile(fullPath)
			if (extension === ".app") {
				files.apps.push(file)
			} else if (extension === ".opt") {
				files.options.push(file)
			} else {
				files.vhds.push(file)
			}
		}
	}

	const sortByPath = (left: { path: string }, right: { path: string }) => left.path.localeCompare(right.path)
	files.apps.sort(sortByPath)
	files.options.sort(sortByPath)
	files.vhds.sort(sortByPath)
	return { rootPath: root, files }
}

export async function chooseInputFolder(window: BrowserWindow, notifyRenderer = false) {
	const result = await dialog.showOpenDialog(window, {
		title: "Select Input Folder",
		properties: ["openDirectory"]
	})

	if (result.canceled || !result.filePaths[0]) {
		return undefined
	}

	const rootPath = result.filePaths[0]
	const config = await updateConfig({ inputRoot: rootPath })
	const scan = await scanInputFolder(rootPath)
	sendConfig(window, config)
	if (notifyRenderer) {
		window.webContents.send("inputFolder:scanned", scan)
	}
	return scan
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
