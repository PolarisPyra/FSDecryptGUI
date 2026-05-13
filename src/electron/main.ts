import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from "electron"
import { mkdir, open, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { ConfigPatch, readRendererConfig, updateConfig } from "./config.js"

type PickFileOptions = {
	title: string
	filters?: Electron.FileFilter[]
	multiple?: boolean
}

type WriteFileRequest = {
	rootPath: string
	segments: string[]
	chunk: ArrayBuffer
	append: boolean
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)

app.setName("fsdecryptGUI")

function resolveRendererPath() {
	return path.join(__dirname, "../dist/index.html")
}

function resolvePreloadPath() {
	return isDev ? path.join(__dirname, "../src/electron/preload.cjs") : path.join(__dirname, "preload.cjs")
}

function safeOutputPath(rootPath: string, segments: string[]) {
	const cleanSegments = segments.filter(Boolean)
	if (cleanSegments.some(segment => segment.includes("/") || segment.includes("\\") || segment === "." || segment === "..")) {
		throw new Error("Invalid output path segment")
	}

	const root = path.resolve(rootPath)
	const target = path.resolve(root, ...cleanSegments)
	const relative = path.relative(root, target)
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("Output path escaped the selected folder")
	}

	return target
}

function focusedWindow() {
	return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

function sendConfig(window: BrowserWindow, config: Awaited<ReturnType<typeof readRendererConfig>>) {
	window.webContents.send("config:changed", config)
}

async function chooseOutputFolder(window: BrowserWindow) {
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

function installMenu() {
	const template: Electron.MenuItemConstructorOptions[] = [
		{
			label: "File",
			submenu: [
				{
					label: "Select Output Folder...",
					accelerator: "CmdOrCtrl+O",
					click: () => {
						const window = focusedWindow()
						if (window) {
							void chooseOutputFolder(window)
						}
					}
				},
				{ type: "separator" },
				process.platform === "darwin" ? { role: "close" } : { role: "quit" }
			]
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" }
			]
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" }
			]
		},
		{
			label: "Window",
			submenu: [{ role: "minimize" }, { role: "close" }]
		}
	]

	Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow() {
	const window = new BrowserWindow({
		width: 1240,
		height: 820,
		minWidth: 920,
		minHeight: 620,
		title: "fsdecryptGUI",
		backgroundColor: "#101418",
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: resolvePreloadPath()
		}
	})

	if (isDev && process.env.VITE_DEV_SERVER_URL) {
		await window.loadURL(process.env.VITE_DEV_SERVER_URL)
		window.webContents.openDevTools({ mode: "detach" })
	} else {
		await window.loadFile(resolveRendererPath())
	}
}

ipcMain.handle("dialog:pickFiles", async (_event, options: PickFileOptions) => {
	const window = BrowserWindow.fromWebContents(_event.sender) ?? focusedWindow()
	const dialogOptions: Electron.OpenDialogOptions = {
		title: options.title,
		properties: options.multiple ? ["openFile", "multiSelections"] : ["openFile"],
		filters: options.filters
	}
	const result = window ? await dialog.showOpenDialog(window, dialogOptions) : await dialog.showOpenDialog(dialogOptions)

	if (result.canceled) {
		return []
	}

	return Promise.all(
		result.filePaths.map(async filePath => {
			const fileStat = await stat(filePath)
			return {
				path: filePath,
				name: path.basename(filePath),
				size: fileStat.size
			}
		})
	)
})

ipcMain.handle("config:read", async () => readRendererConfig())

ipcMain.handle("config:update", async (_event, patch: ConfigPatch) => updateConfig(patch))

ipcMain.handle("config:openFolder", async () => {
	const config = await readRendererConfig()
	const folder = path.dirname(config.configPath)
	await mkdir(folder, { recursive: true })
	const error = await shell.openPath(folder)
	if (error) {
		throw new Error(error)
	}
})

ipcMain.handle("fs:readRange", async (_event, filePath: string, offset: number, length: number) => {
	const handle = await open(filePath, "r")
	try {
		const buffer = Buffer.alloc(length)
		const { bytesRead } = await handle.read(buffer, 0, length, offset)
		return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead)
	} finally {
		await handle.close()
	}
})

ipcMain.handle("fs:ensureDirectory", async (_event, rootPath: string, segments: string[]) => {
	const target = safeOutputPath(rootPath, segments)
	await mkdir(target, { recursive: true })
})

ipcMain.handle("fs:writeFileChunk", async (_event, request: WriteFileRequest) => {
	const target = safeOutputPath(request.rootPath, request.segments)
	await mkdir(path.dirname(target), { recursive: true })
	await writeFile(target, Buffer.from(request.chunk), { flag: request.append ? "a" : "w" })
})

app.whenReady().then(() => {
	installMenu()
	return createWindow()
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
