import { BrowserWindow, dialog } from "electron"
import { readdir } from "node:fs/promises"
import path from "node:path"

import { readRendererConfig, updateConfig } from "./config.js"
import type { ScannedInputFolder } from "./ipcTypes.js"
import { pickedFile } from "./pickedFile.js"

/**
 * Broadcasts updated config to the renderer after menu-driven changes.
 *
 * @param window Target window whose renderer should receive the config.
 * @param config Renderer config payload.
 */
function sendConfig(window: BrowserWindow, config: Awaited<ReturnType<typeof readRendererConfig>>) {
	window.webContents.send("config:changed", config)
}

/**
 * Recursively scans a user-selected input folder and classifies files by the
 * extraction modes that understand them. Hidden folders/files are skipped so a
 * project checkout or mounted drive does not accidentally enqueue metadata.
 *
 * @param rootPath Folder selected by the user.
 * @returns Classified APP, OPTION, and VHD file metadata.
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

/**
 * Opens the output folder chooser and stores the selected Output Folder.
 *
 * @param window Window that should own the folder dialog.
 * @returns The selected folder path, or undefined when cancelled.
 */
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

/**
 * Opens the input folder chooser, stores the root, and optionally broadcasts a scan.
 *
 * @param window Window that should own the folder dialog.
 * @param notifyRenderer Whether to send the scan result back to the renderer.
 * @returns The scan result, or undefined when cancelled.
 */
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
