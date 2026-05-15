import { BrowserWindow, dialog } from "electron"
import { readdir } from "node:fs/promises"
import path from "node:path"

import { readRendererConfig, updateConfig } from "./config.js"
import type { ScannedInputFolder } from "./ipcTypes.js"
import { pickedFile } from "./pickedFile.js"

function sendConfig(window: BrowserWindow, config: Awaited<ReturnType<typeof readRendererConfig>>) {
	window.webContents.send("config:changed", config)
}

/**
 * Recursively scans a user-selected input folder and classifies files by the
 * extraction modes that understand them. Hidden folders/files are skipped so a
 * project checkout or mounted drive does not accidentally enqueue metadata.
 */
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
