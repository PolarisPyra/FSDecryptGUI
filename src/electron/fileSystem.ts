import { createDecipheriv } from "node:crypto"
import { open, type FileHandle } from "node:fs/promises"
import path from "node:path"

const inputHandles = new Map<string, Promise<FileHandle>>()
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

function cachedKey(hex: string) {
	let key = fscryptKeys.get(hex)
	if (!key) {
		key = hexBytes(hex)
		fscryptKeys.set(hex, key)
	}
	return key
}

export async function closeInputHandles() {
	const handles = [...inputHandles.values()]
	inputHandles.clear()
	await Promise.allSettled(handles.map(async handle => (await handle).close()))
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
