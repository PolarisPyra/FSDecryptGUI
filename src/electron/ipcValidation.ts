import type {
	ConfigPatch,
	DecryptFscryptRangeRequest,
	NotifyRequest,
	OutputFolderRequest,
	PickFileOptions,
	SaveBinaryRequest,
	SaveTextRequest,
	WriteFileRequest
} from "./ipcTypes.js"

const MAX_PATH_LENGTH = 4096
const MAX_TEXT_LENGTH = 5 * 1024 * 1024
const MAX_TITLE_LENGTH = 200
const MAX_NOTIFICATION_LENGTH = 1000
const MAX_SEGMENT_LENGTH = 255
const MAX_CHUNK_LENGTH = 8 * 1024 * 1024
const MAX_READ_LENGTH = 64 * 1024 * 1024
const HEX_128_BIT = /^[0-9a-fA-F]{32}$/

/**
 * Runtime validation helpers for Electron IPC handlers.
 *
 * TypeScript protects the renderer call sites, but IPC payloads cross a trust
 * boundary at runtime. These functions keep validation close to the main-process
 * handler and return the same typed request objects the adapters expect.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown, label: string, maxLength = MAX_PATH_LENGTH) {
	if (typeof value !== "string") {
		throw new Error(`${label} must be a string`)
	}

	if (value.length > maxLength) {
		throw new Error(`${label} is too long`)
	}

	return value
}

function asOptionalString(value: unknown, label: string, maxLength = MAX_PATH_LENGTH) {
	if (value === undefined || value === null) {
		return value
	}

	return asString(value, label, maxLength)
}

function asFiniteNumber(value: unknown, label: string) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must be a finite number`)
	}

	return value
}

function asNonNegativeInteger(value: unknown, label: string) {
	const number = asFiniteNumber(value, label)
	if (!Number.isInteger(number) || number < 0) {
		throw new Error(`${label} must be a non-negative integer`)
	}

	return number
}

function asPositiveInteger(value: unknown, label: string) {
	const number = asNonNegativeInteger(value, label)
	if (number <= 0) {
		throw new Error(`${label} must be greater than zero`)
	}

	return number
}

function asHex128(value: unknown, label: string) {
	const text = asString(value, label, 32)
	if (!HEX_128_BIT.test(text)) {
		throw new Error(`${label} must be 32 hex characters`)
	}

	return text.toLowerCase()
}

function asBoolean(value: unknown, label: string) {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a boolean`)
	}

	return value
}

function asStringArray(value: unknown, label: string, maxLength = MAX_SEGMENT_LENGTH) {
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array`)
	}

	return value.map((item, index) => asString(item, `${label}[${index}]`, maxLength))
}

function isBinaryContent(value: unknown): value is ArrayBuffer | Uint8Array {
	return value instanceof ArrayBuffer || value instanceof Uint8Array
}

export function validatePickFileOptions(value: unknown): PickFileOptions {
	if (!isRecord(value)) {
		throw new Error("Pick file options must be an object")
	}

	const filters = value.filters
	return {
		title: asString(value.title, "title", MAX_TITLE_LENGTH),
		multiple: value.multiple === undefined ? undefined : asBoolean(value.multiple, "multiple"),
		filters: Array.isArray(filters)
			? filters.map((filter, index) => {
					if (!isRecord(filter)) {
						throw new Error(`filters[${index}] must be an object`)
					}

					return {
						name: asString(filter.name, `filters[${index}].name`, MAX_TITLE_LENGTH),
						extensions: asStringArray(filter.extensions, `filters[${index}].extensions`, 32)
					}
				})
			: undefined
	}
}

/**
 * Validates partial config writes coming from renderer settings actions.
 *
 * @param value Unknown IPC payload.
 * @returns A sanitized config patch with only known optional fields.
 */
export function validateConfigPatch(value: unknown): ConfigPatch {
	if (!isRecord(value)) {
		throw new Error("Config patch must be an object")
	}

	return {
		inputRoot: asOptionalString(value.inputRoot, "inputRoot"),
		outputRoot: asOptionalString(value.outputRoot, "outputRoot"),
		keyFilePath: asOptionalString(value.keyFilePath, "keyFilePath")
	}
}

/**
 * Validates text-save requests before passing content to the filesystem adapter.
 *
 * @param value Unknown IPC payload.
 * @returns A bounded text save request.
 */
export function validateSaveTextRequest(value: unknown): SaveTextRequest {
	if (!isRecord(value)) {
		throw new Error("Save text request must be an object")
	}

	return {
		defaultName: asString(value.defaultName, "defaultName", MAX_PATH_LENGTH),
		content: asString(value.content, "content", MAX_TEXT_LENGTH)
	}
}

/**
 * Validates binary-save requests for ICF export.
 *
 * @param value Unknown IPC payload.
 * @returns A request with bounded filename and binary content.
 */
export function validateSaveBinaryRequest(value: unknown): SaveBinaryRequest {
	if (!isRecord(value)) {
		throw new Error("Save binary request must be an object")
	}

	if (!isBinaryContent(value.content)) {
		throw new Error("content must be binary data")
	}

	return {
		defaultName: asString(value.defaultName, "defaultName", MAX_PATH_LENGTH),
		content: value.content
	}
}

/**
 * Validates desktop notification contents.
 *
 * @param value Unknown IPC payload.
 * @returns Bounded title/body strings.
 */
export function validateNotifyRequest(value: unknown): NotifyRequest {
	if (!isRecord(value)) {
		throw new Error("Notification request must be an object")
	}

	return {
		title: asString(value.title, "title", MAX_TITLE_LENGTH),
		body: asString(value.body, "body", MAX_NOTIFICATION_LENGTH)
	}
}

/**
 * Validates Output Folder operations before path traversal checks run.
 *
 * @param value Unknown IPC payload.
 * @returns Root path plus clean path segments.
 */
export function validateOutputFolderRequest(value: unknown): OutputFolderRequest {
	if (!isRecord(value)) {
		throw new Error("Output folder request must be an object")
	}

	return {
		rootPath: asString(value.rootPath, "rootPath", MAX_PATH_LENGTH),
		segments: asStringArray(value.segments, "segments")
	}
}

/**
 * Validates one chunked file-write operation.
 *
 * @param value Unknown IPC payload.
 * @returns Bounded binary chunk write request.
 */
export function validateWriteFileRequest(value: unknown): WriteFileRequest {
	if (!isRecord(value)) {
		throw new Error("Write file request must be an object")
	}

	if (!isBinaryContent(value.chunk)) {
		throw new Error("chunk must be binary data")
	}

	const chunkLength = value.chunk instanceof ArrayBuffer ? value.chunk.byteLength : value.chunk.byteLength
	if (chunkLength > MAX_CHUNK_LENGTH) {
		throw new Error("chunk is too large")
	}

	return {
		...validateOutputFolderRequest(value),
		chunk: value.chunk,
		append: asBoolean(value.append, "append")
	}
}

/**
 * Validates native fscrypt decryption requests.
 *
 * @param value Unknown IPC payload.
 * @returns AES-CBC range request with 128-bit key and IV hex material.
 */
export function validateDecryptFscryptRangeRequest(value: unknown): DecryptFscryptRangeRequest {
	if (!isRecord(value)) {
		throw new Error("Decrypt range request must be an object")
	}

	return {
		filePath: asString(value.filePath, "filePath"),
		dataOffset: asNonNegativeInteger(value.dataOffset, "dataOffset"),
		outputSize: asNonNegativeInteger(value.outputSize, "outputSize"),
		keyHex: asHex128(value.keyHex, "keyHex"),
		ivHex: asHex128(value.ivHex, "ivHex"),
		offset: asNonNegativeInteger(value.offset, "offset"),
		length: Math.min(asNonNegativeInteger(value.length, "length"), MAX_READ_LENGTH),
		pageSize: asPositiveInteger(value.pageSize, "pageSize")
	}
}

/**
 * Validates a single path argument used by scan/open helpers.
 *
 * @param filePath Unknown IPC payload.
 * @returns A bounded path string.
 */
export function validateFilePath(filePath: unknown) {
	return asString(filePath, "filePath")
}

/**
 * Validates bounded random-access file reads from the renderer.
 *
 * @param filePath Unknown path payload.
 * @param offset Unknown offset payload.
 * @param length Unknown length payload.
 * @returns A read request capped to the maximum IPC read size.
 */
export function validateReadRange(filePath: unknown, offset: unknown, length: unknown) {
	return {
		filePath: asString(filePath, "filePath"),
		offset: asNonNegativeInteger(offset, "offset"),
		length: Math.min(asNonNegativeInteger(length, "length"), MAX_READ_LENGTH)
	}
}

/**
 * Validates root-plus-segments APIs that pass arguments separately.
 *
 * @param rootPath Unknown output root payload.
 * @param segments Unknown path segment payload.
 * @returns A normalized Output Folder request.
 */
export function validateOutputSegments(rootPath: unknown, segments: unknown) {
	return validateOutputFolderRequest({ rootPath, segments })
}
