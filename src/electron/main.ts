import { app, BrowserWindow, Notification, clipboard, ipcMain, shell } from "electron"
import { mkdir } from "node:fs/promises"

import { ConfigPatch, readRendererConfig, updateConfig } from "./config.js"
import { createWindow, focusedWindow, installMenu } from "./chrome.js"
import { chooseInputFolder, chooseOutputFolder, openConfigFolder, pickFiles, saveText, scanInputFolder } from "./dialogs.js"
import {
	closeInputHandles,
	closeOutputHandle,
	closeOutputHandles,
	decryptFscryptRange,
	ensureOutputDirectory,
	prepareOutputFolder,
	readInputRange,
	removeOutputPath,
	safeOutputPath,
	writeOutputFileChunk
} from "./fileSystem.js"
import type { DecryptFscryptRangeRequest, OutputFolderRequest, SaveTextRequest, WriteFileRequest } from "./ipcTypes.js"

app.setName("fsdecryptGUI")

ipcMain.handle("dialog:pickFiles", async (_event, options) => {
	const window = BrowserWindow.fromWebContents(_event.sender) ?? focusedWindow()
	return pickFiles(window, options)
})

ipcMain.handle("dialog:selectOutputFolder", async (_event) => {
	const window = BrowserWindow.fromWebContents(_event.sender) ?? focusedWindow()
	if (!window) {
		return undefined
	}

	return chooseOutputFolder(window)
})

ipcMain.handle("dialog:selectInputFolder", async (_event) => {
	const window = BrowserWindow.fromWebContents(_event.sender) ?? focusedWindow()
	if (!window) {
		return undefined
	}

	return chooseInputFolder(window)
})

ipcMain.handle("fs:scanInputFolder", async (_event, rootPath: string) => scanInputFolder(rootPath))

ipcMain.handle("config:read", async () => readRendererConfig())

ipcMain.handle("config:update", async (_event, patch: ConfigPatch) => updateConfig(patch))

ipcMain.handle("config:openFolder", async () => openConfigFolder())

ipcMain.handle("app:copyText", async (_event, text: string) => {
	clipboard.writeText(text)
})

ipcMain.handle("app:saveText", async (_event, request: SaveTextRequest) => {
	const window = BrowserWindow.fromWebContents(_event.sender) ?? focusedWindow()
	return saveText(window, request)
})

ipcMain.handle("app:notify", async (_event, request: { title: string; body: string }) => {
	const window = BrowserWindow.fromWebContents(_event.sender) ?? focusedWindow()
	if (window) {
		if (!window.isFocused()) {
			window.flashFrame(true)
			window.once("focus", () => window.flashFrame(false))
		}
	}

	if (Notification.isSupported()) {
		new Notification({
			title: request.title,
			body: request.body
		}).show()
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

ipcMain.handle("fs:readRange", async (_event, filePath: string, offset: number, length: number) => readInputRange(filePath, offset, length))

ipcMain.handle("fs:decryptFscryptRange", async (_event, request: DecryptFscryptRangeRequest) => decryptFscryptRange(request))

ipcMain.handle("fs:ensureDirectory", async (_event, rootPath: string, segments: string[]) => {
	await ensureOutputDirectory(safeOutputPath(rootPath, segments))
})

ipcMain.handle("fs:writeFileChunk", async (_event, request: WriteFileRequest) => {
	await writeOutputFileChunk(request.rootPath, request.segments, request.chunk, request.append)
})

ipcMain.handle("fs:closeOutputFile", async (_event, request: OutputFolderRequest) => {
	await closeOutputHandle(safeOutputPath(request.rootPath, request.segments))
})

ipcMain.handle("fs:removeOutputPath", async (_event, request: OutputFolderRequest) => {
	await removeOutputPath(request.rootPath, request.segments)
})

app.whenReady().then(() => {
	installMenu({ chooseInputFolder, chooseOutputFolder })
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
