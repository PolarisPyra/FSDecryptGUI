import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from "electron"
import { createDecipheriv } from "node:crypto"
import { mkdir, open, rm, stat, type FileHandle } from "node:fs/promises"
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
	chunk: ArrayBuffer | Uint8Array
	append: boolean
}

type DecryptFscryptRangeRequest = {
	filePath: string
	dataOffset: number
	outputSize: number
	keyHex: string
	ivHex: string
	offset: number
	length: number
	pageSize: number
}

type OutputFolderRequest = {
	rootPath: string
	segments: string[]
}

function hexBytes(hex: string) {
	return Buffer.from(hex, "hex")
}

function calculatePageIv(fileOffset: number, fileIv: Buffer) {
	const pageIv = Buffer.allocUnsafe(16)
	let low = BigInt(fileOffset)

	for (let index = 0; index < 16; index++) {
		const shift = BigInt(8 * (index % 8))
		pageIv[index] = fileIv[index] ^ Number((low >> shift) & 0xffn)
	}

	return pageIv
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
const inputHandles = new Map<string, Promise<FileHandle>>()
const outputHandles = new Map<string, Promise<FileHandle>>()
const ensuredOutputDirectories = new Set<string>()
const fscryptKeys = new Map<string, Buffer>()

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

async function pathExists(target: string) {
	try {
		await stat(target)
		return true
	} catch {
		return false
	}
}

function inputHandle(filePath: string) {
	const resolved = path.resolve(filePath)
	let handle = inputHandles.get(resolved)
	if (!handle) {
		handle = open(resolved, "r").catch(error => {
			inputHandles.delete(resolved)
			throw error
		})
		inputHandles.set(resolved, handle)
	}

	return handle
}

async function closeInputHandles() {
	const handles = [...inputHandles.values()]
	inputHandles.clear()
	await Promise.allSettled(handles.map(async handle => (await handle).close()))
}

async function closeOutputHandles() {
	const handles = [...outputHandles.values()]
	outputHandles.clear()
	await Promise.allSettled(handles.map(async handle => (await handle).close()))
}

async function closeOutputHandle(target: string) {
	const resolved = path.resolve(target)
	const handle = outputHandles.get(resolved)
	if (!handle) {
		return
	}

	outputHandles.delete(resolved)
	await (await handle).close()
}

function openOutputHandle(target: string, flags: "a" | "w") {
	const resolved = path.resolve(target)
	const handle = open(resolved, flags).catch(error => {
		outputHandles.delete(resolved)
		throw error
	})
	outputHandles.set(resolved, handle)
	return handle
}

function cachedKey(hex: string) {
	let key = fscryptKeys.get(hex)
	if (!key) {
		key = hexBytes(hex)
		fscryptKeys.set(hex, key)
	}
	return key
}

function chunkBuffer(chunk: ArrayBuffer | Uint8Array) {
	if (chunk instanceof ArrayBuffer) {
		return Buffer.from(chunk)
	}
	return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
}

async function ensureOutputDirectory(target: string) {
	if (ensuredOutputDirectories.has(target)) {
		return
	}

	await mkdir(target, { recursive: true })
	ensuredOutputDirectories.add(target)
}

async function prepareOutputFolder(window: BrowserWindow | undefined, target: string) {
	await closeOutputHandles()
	ensuredOutputDirectories.clear()
	if (!(await pathExists(target))) {
		await mkdir(target, { recursive: true })
		return
	}

	const result = window
		? await dialog.showMessageBox(window, {
				type: "question",
				message: "Output folder already exists",
				detail: `${target}\n\nReplace deletes the existing folder first. Merge keeps the folder and overwrites matching files.`,
				buttons: ["Replace", "Merge", "Cancel"],
				defaultId: 1,
				cancelId: 2,
				noLink: true
			})
		: await dialog.showMessageBox({
				type: "question",
				message: "Output folder already exists",
				detail: `${target}\n\nReplace deletes the existing folder first. Merge keeps the folder and overwrites matching files.`,
				buttons: ["Replace", "Merge", "Cancel"],
				defaultId: 1,
				cancelId: 2,
				noLink: true
			})

	if (result.response === 2) {
		throw new Error("Extraction cancelled")
	}

	if (result.response === 0) {
		await rm(target, { recursive: true, force: true })
	}

	await mkdir(target, { recursive: true })
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
		width: 1480,
		height: 960,
		minWidth: 1100,
		minHeight: 720,
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

ipcMain.handle("dialog:selectOutputFolder", async (_event) => {
	const window = BrowserWindow.fromWebContents(_event.sender) ?? focusedWindow()
	if (!window) {
		return undefined
	}

	return chooseOutputFolder(window)
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

ipcMain.handle("fs:prepareOutputFolder", async (_event, request: OutputFolderRequest) => {
	const window = BrowserWindow.fromWebContents(_event.sender) ?? focusedWindow()
	await prepareOutputFolder(window, safeOutputPath(request.rootPath, request.segments))
})

ipcMain.handle("fs:openOutputFolder", async (_event, request: OutputFolderRequest) => {
	const target = safeOutputPath(request.rootPath, request.segments)
	await mkdir(target, { recursive: true })
	const error = await shell.openPath(target)
	if (error) {
		throw new Error(error)
	}
})

ipcMain.handle("fs:readRange", async (_event, filePath: string, offset: number, length: number) => {
	const handle = await inputHandle(filePath)
	const buffer = Buffer.allocUnsafe(length)
	const { bytesRead } = await handle.read(buffer, 0, length, offset)
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead)
})

ipcMain.handle("fs:decryptFscryptRange", async (_event, request: DecryptFscryptRangeRequest) => {
	if (request.offset < 0 || request.length < 0 || request.offset > request.outputSize) {
		throw new Error(`Invalid plaintext read ${request.offset}+${request.length}`)
	}

	const cappedLength = Math.min(request.length, request.outputSize - request.offset)
	if (cappedLength <= 0) {
		return new ArrayBuffer(0)
	}

	const firstPageOffset = Math.floor(request.offset / request.pageSize) * request.pageSize
	const lastPageOffset = Math.ceil((request.offset + cappedLength) / request.pageSize) * request.pageSize
	const encryptedLength = Math.min(lastPageOffset, request.outputSize) - firstPageOffset
	if (encryptedLength % 16 !== 0) {
		throw new Error("Encrypted range is not AES block aligned")
	}

	const handle = await inputHandle(request.filePath)
	const encrypted = Buffer.allocUnsafe(encryptedLength)
	const { bytesRead } = await handle.read(encrypted, 0, encryptedLength, request.dataOffset + firstPageOffset)
	const key = cachedKey(request.keyHex)
	const fileIv = hexBytes(request.ivHex)
	const decrypted = Buffer.allocUnsafe(bytesRead)

	for (let pageOffset = 0; pageOffset < bytesRead; pageOffset += request.pageSize) {
		const encryptedPage = encrypted.subarray(pageOffset, Math.min(bytesRead, pageOffset + request.pageSize))
		const decipher = createDecipheriv("aes-128-cbc", key, calculatePageIv(firstPageOffset + pageOffset, fileIv))
		decipher.setAutoPadding(false)
		decipher.update(encryptedPage).copy(decrypted, pageOffset)
		decipher.final()
	}

	const sliceStart = request.offset - firstPageOffset
	const sliceEnd = sliceStart + cappedLength
	return decrypted.buffer.slice(decrypted.byteOffset + sliceStart, decrypted.byteOffset + sliceEnd)
})

ipcMain.handle("fs:ensureDirectory", async (_event, rootPath: string, segments: string[]) => {
	const target = safeOutputPath(rootPath, segments)
	await ensureOutputDirectory(target)
})

ipcMain.handle("fs:writeFileChunk", async (_event, request: WriteFileRequest) => {
	const target = safeOutputPath(request.rootPath, request.segments)
	await ensureOutputDirectory(path.dirname(target))
	const resolved = path.resolve(target)

	if (!request.append) {
		await closeOutputHandle(resolved)
		openOutputHandle(resolved, "w")
	}

	let handle = outputHandles.get(resolved)
	if (!handle) {
		handle = openOutputHandle(resolved, "a")
	}

	await (await handle).write(chunkBuffer(request.chunk))
})

ipcMain.handle("fs:closeOutputFile", async (_event, request: OutputFolderRequest) => {
	await closeOutputHandle(safeOutputPath(request.rootPath, request.segments))
})

ipcMain.handle("fs:removeOutputPath", async (_event, request: OutputFolderRequest) => {
	const target = safeOutputPath(request.rootPath, request.segments)
	await closeOutputHandle(target)
	await rm(target, { recursive: true, force: true })
})

app.whenReady().then(() => {
	installMenu()
	return createWindow()
})

app.on("before-quit", () => {
	void closeInputHandles()
	void closeOutputHandles()
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
