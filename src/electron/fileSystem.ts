import { BrowserWindow, dialog } from "electron"
import { createDecipheriv } from "node:crypto"
import { mkdir, open, rm, stat, type FileHandle } from "node:fs/promises"
import path from "node:path"

const inputHandles = new Map<string, Promise<FileHandle>>()
const outputHandles = new Map<string, Promise<FileHandle>>()
const ensuredOutputDirectories = new Set<string>()
const fscryptKeys = new Map<string, Buffer>()

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

async function pathExists(target: string) {
	try {
		await stat(target)
		return true
	} catch {
		return false
	}
}

export function safeOutputPath(rootPath: string, segments: string[]) {
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

export async function closeInputHandles() {
	const handles = [...inputHandles.values()]
	inputHandles.clear()
	await Promise.allSettled(handles.map(async handle => (await handle).close()))
}

export async function closeOutputHandles() {
	const handles = [...outputHandles.values()]
	outputHandles.clear()
	await Promise.allSettled(handles.map(async handle => (await handle).close()))
}

export async function closeOutputHandle(target: string) {
	const resolved = path.resolve(target)
	const handle = outputHandles.get(resolved)
	if (!handle) {
		return
	}

	outputHandles.delete(resolved)
	await (await handle).close()
}

export async function ensureOutputDirectory(target: string) {
	if (ensuredOutputDirectories.has(target)) {
		return
	}

	await mkdir(target, { recursive: true })
	ensuredOutputDirectories.add(target)
}

export async function prepareOutputFolder(window: BrowserWindow | undefined, target: string) {
	await closeOutputHandles()
	ensuredOutputDirectories.clear()
	if (!(await pathExists(target))) {
		await mkdir(target, { recursive: true })
		return
	}

	const messageBox = {
		type: "question" as const,
		message: "Output folder already exists",
		detail: `${target}\n\nReplace deletes the existing folder first. Merge keeps the folder and overwrites matching files.`,
		buttons: ["Replace", "Merge", "Cancel"],
		defaultId: 1,
		cancelId: 2,
		noLink: true
	}
	const result = window ? await dialog.showMessageBox(window, messageBox) : await dialog.showMessageBox(messageBox)

	if (result.response === 2) {
		throw new Error("Extraction cancelled")
	}

	if (result.response === 0) {
		await rm(target, { recursive: true, force: true })
	}

	await mkdir(target, { recursive: true })
}

export async function readInputRange(filePath: string, offset: number, length: number) {
	const handle = await inputHandle(filePath)
	const buffer = Buffer.allocUnsafe(length)
	const { bytesRead } = await handle.read(buffer, 0, length, offset)
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead)
}

export async function decryptFscryptRange(request: {
	filePath: string
	dataOffset: number
	outputSize: number
	keyHex: string
	ivHex: string
	offset: number
	length: number
	pageSize: number
}) {
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
}

export async function writeOutputFileChunk(rootPath: string, segments: string[], chunk: ArrayBuffer | Uint8Array, append: boolean) {
	const target = safeOutputPath(rootPath, segments)
	await ensureOutputDirectory(path.dirname(target))
	const resolved = path.resolve(target)

	if (!append) {
		await closeOutputHandle(resolved)
		openOutputHandle(resolved, "w")
	}

	let handle = outputHandles.get(resolved)
	if (!handle) {
		handle = openOutputHandle(resolved, "a")
	}

	await (await handle).write(chunkBuffer(chunk))
}

export async function removeOutputPath(rootPath: string, segments: string[]) {
	const target = safeOutputPath(rootPath, segments)
	await closeOutputHandle(target)
	await rm(target, { recursive: true, force: true })
}
