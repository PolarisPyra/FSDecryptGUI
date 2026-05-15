import { ipcMain } from "electron"

import { decryptFscryptRange, readInputRange } from "../fileSystem.js"
import { outputFolders } from "../folderManager.js"
import { scanInputFolder } from "../folderSelection.js"
import {
	validateDecryptFscryptRangeRequest,
	validateFilePath,
	validateOutputFolderRequest,
	validateOutputSegments,
	validateReadRange,
	validateWriteFileRequest
} from "../ipcValidation.js"
import { windowForEvent } from "./window.js"

/** Registers validated filesystem IPC for scanning, reading, decrypting, and writing output chunks. */
export function registerFileSystemHandlers() {
	ipcMain.handle("fs:scanInputFolder", async (_event, rootPath: unknown) => scanInputFolder(validateFilePath(rootPath)))

	ipcMain.handle("fs:prepareOutputFolder", async (event, request: unknown) => {
		const validated = validateOutputFolderRequest(request)
		await outputFolders.prepareFolder(windowForEvent(event), validated.rootPath, validated.segments)
	})

	ipcMain.handle("fs:openOutputFolder", async (_event, request: unknown) => {
		const validated = validateOutputFolderRequest(request)
		await outputFolders.openFolder(validated.rootPath, validated.segments)
	})

	ipcMain.handle("fs:readRange", async (_event, filePath: unknown, offset: unknown, length: unknown) => {
		const request = validateReadRange(filePath, offset, length)
		return readInputRange(request.filePath, request.offset, request.length)
	})

	ipcMain.handle("fs:decryptFscryptRange", async (_event, request: unknown) => decryptFscryptRange(validateDecryptFscryptRangeRequest(request)))

	ipcMain.handle("fs:ensureDirectory", async (_event, rootPath: unknown, segments: unknown) => {
		const request = validateOutputSegments(rootPath, segments)
		await outputFolders.ensureDirectory(request.rootPath, request.segments)
	})

	ipcMain.handle("fs:writeFileChunk", async (_event, request: unknown) => {
		const validated = validateWriteFileRequest(request)
		await outputFolders.writeFileChunk(validated.rootPath, validated.segments, validated.chunk, validated.append)
	})

	ipcMain.handle("fs:closeOutputFile", async (_event, request: unknown) => {
		const validated = validateOutputFolderRequest(request)
		await outputFolders.closeOpenFile(validated.rootPath, validated.segments)
	})

	ipcMain.handle("fs:removeOutputPath", async (_event, request: unknown) => {
		const validated = validateOutputFolderRequest(request)
		await outputFolders.removePath(validated.rootPath, validated.segments)
	})
}
