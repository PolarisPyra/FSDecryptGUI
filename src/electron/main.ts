import { app, BrowserWindow, Notification, clipboard, ipcMain } from "electron"

import { ConfigPatch, readRendererConfig, updateConfig } from "./config.js"
import { createWindow, focusedWindow, installMenu } from "./chrome.js"
import { openConfigFolder, pickFiles, saveBinary, saveText } from "./dialogs.js"
import { closeInputHandles, decryptFscryptRange, readInputRange } from "./fileSystem.js"
import { outputFolders } from "./folderManager.js"
import { chooseInputFolder, chooseOutputFolder, scanInputFolder } from "./folderSelection.js"
import type { DecryptFscryptRangeRequest, OutputFolderRequest, SaveBinaryRequest, SaveTextRequest, WriteFileRequest } from "./ipcTypes.js"

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

ipcMain.handle("app:saveBinary", async (_event, request: SaveBinaryRequest) => {
	const window = BrowserWindow.fromWebContents(_event.sender) ?? focusedWindow()
	return saveBinary(window, request)
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
	await outputFolders.prepareFolder(window, request.rootPath, request.segments)
})

ipcMain.handle("fs:openOutputFolder", async (_event, request: OutputFolderRequest) => {
	await outputFolders.openFolder(request.rootPath, request.segments)
})

ipcMain.handle("fs:readRange", async (_event, filePath: string, offset: number, length: number) => readInputRange(filePath, offset, length))

ipcMain.handle("fs:decryptFscryptRange", async (_event, request: DecryptFscryptRangeRequest) => decryptFscryptRange(request))

ipcMain.handle("fs:ensureDirectory", async (_event, rootPath: string, segments: string[]) => {
	await outputFolders.ensureDirectory(rootPath, segments)
})

ipcMain.handle("fs:writeFileChunk", async (_event, request: WriteFileRequest) => {
	await outputFolders.writeFileChunk(request.rootPath, request.segments, request.chunk, request.append)
})

ipcMain.handle("fs:closeOutputFile", async (_event, request: OutputFolderRequest) => {
	await outputFolders.closeOpenFile(request.rootPath, request.segments)
})

ipcMain.handle("fs:removeOutputPath", async (_event, request: OutputFolderRequest) => {
	await outputFolders.removePath(request.rootPath, request.segments)
})

app.whenReady().then(() => {
	installMenu({ chooseInputFolder, chooseOutputFolder })
	return createWindow()
})

app.on("before-quit", () => {
	void closeInputHandles()
	void outputFolders.closeAllOpenFiles()
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
