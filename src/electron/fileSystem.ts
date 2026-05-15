import { createDecipheriv } from "node:crypto"
import { open, type FileHandle } from "node:fs/promises"
import path from "node:path"

import type { DecryptFscryptRangeRequest } from "./ipcTypes.js"

const inputHandles = new Map<string, Promise<FileHandle>>()
const fscryptKeys = new Map<string, Buffer>()

/**
 * Converts validated hex key material into a Node buffer.
 *
 * @param hex 128-bit AES key or IV encoded as hex.
 * @returns Binary key material for Node crypto.
 */
function hexBytes(hex: string) {
	return Buffer.from(hex, "hex")
}

/**
 * Recreates the per-page IV used by fscrypt for a plaintext file offset.
 *
 * @param fileOffset Plaintext offset for the start of the page.
 * @param fileIv Base IV recovered from container metadata.
 * @returns The IV to use for the requested page.
 */
function calculatePageIv(fileOffset: number, fileIv: Buffer) {
	const pageIv = Buffer.allocUnsafe(16)
	const low = BigInt(fileOffset)

	for (let index = 0; index < 16; index++) {
		const shift = BigInt(8 * (index % 8))
		pageIv[index] = fileIv[index] ^ Number((low >> shift) & 0xffn)
	}

	return pageIv
}

/**
 * Opens and caches input file handles by resolved path.
 *
 * @param filePath Path selected by the user and validated by the IPC layer.
 * @returns A reusable read-only file handle.
 */
function inputHandle(filePath: string) {
	const resolved = path.resolve(filePath)
	let handle: Promise<FileHandle> | undefined = inputHandles.get(resolved)
	if (!handle) {
		handle = open(resolved, "r").catch((error: unknown) => {
			inputHandles.delete(resolved)
			throw error
		})
		inputHandles.set(resolved, handle)
	}

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

function assertCompleteRead(bytesRead: number, expectedLength: number, filePath: string) {
	if (bytesRead !== expectedLength) {
		throw new Error(`Could not read ${expectedLength.toLocaleString()} encrypted bytes from ${path.basename(filePath)}`)
	}
}

/**
 * Closes every cached input file handle during app shutdown.
 *
 * @returns A promise that settles once all open handles have been drained.
 */
export async function closeInputHandles() {
	const handles = [...inputHandles.values()]
	inputHandles.clear()
	await Promise.allSettled(handles.map(async handle => (await handle).close()))
}

/**
 * Reads a byte range from a user-selected input file.
 *
 * @param filePath Absolute file path from the renderer-side picked file.
 * @param offset Byte offset to start reading.
 * @param length Maximum number of bytes to read.
 * @returns An ArrayBuffer containing the bytes actually read.
 */
export async function readInputRange(filePath: string, offset: number, length: number) {
	const handle = await inputHandle(filePath)
	const buffer = Buffer.allocUnsafe(length)
	const { bytesRead } = await handle.read(buffer, 0, length, offset)
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead)
}

/**
 * Decrypts a plaintext fscrypt range in the main process using native crypto.
 *
 * @param request Validated decrypt range request with key material and offsets.
 * @returns Decrypted plaintext bytes for the requested range.
 */
export async function decryptFscryptRange(request: DecryptFscryptRangeRequest) {
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
	assertCompleteRead(bytesRead, encryptedLength, request.filePath)
	const key = cachedKey(request.keyHex)
	const fileIv = hexBytes(request.ivHex)
	const decrypted = Buffer.allocUnsafe(encryptedLength)

	for (let pageOffset = 0; pageOffset < encryptedLength; pageOffset += request.pageSize) {
		const encryptedPage = encrypted.subarray(pageOffset, Math.min(encryptedLength, pageOffset + request.pageSize))
		if (encryptedPage.length % 16 !== 0) {
			throw new Error("Encrypted page is not AES block aligned")
		}

		const decipher = createDecipheriv("aes-128-cbc", key, calculatePageIv(firstPageOffset + pageOffset, fileIv))
		decipher.setAutoPadding(false)
		decipher.update(encryptedPage).copy(decrypted, pageOffset)
		decipher.final()
	}

	const sliceStart = request.offset - firstPageOffset
	const sliceEnd = sliceStart + cappedLength
	return decrypted.buffer.slice(decrypted.byteOffset + sliceStart, decrypted.byteOffset + sliceEnd)
}
