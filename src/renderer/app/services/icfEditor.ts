import {
	binToHex,
	decodeIcfEntries,
	decryptIcf,
	encodeIcfEntries,
	encryptIcf,
	getIcfSanityError,
	hexToBin,
	inferIcfFilename,
	xxdEncode,
	xxdDecode
} from "./icf"

// ICF editor state transitions are kept outside React so validation, load, dump,
// and save behavior can be tested without the Electron file dialog adapter.
const ICF_BLOCK_SIZE = 0x40

export const ICF_EDITOR_STORAGE_KEY = "fsdecryptGUI.icfEditor"
export const DEFAULT_ICF_ENTRIES = ["SXXXACA0"]

export type IcfEditorState = {
	data: Uint8Array
	entries: string[]
	error: string
	warning: string
}

export type LoadedIcfBytes = {
	state: IcfEditorState
	status: string
}

/**
 * Creates an owned copy of ICF bytes before storing them in React state.
 *
 * @param data Source byte array.
 * @returns New Uint8Array with copied contents.
 */
export function cloneIcfData(data: Uint8Array<ArrayBufferLike>) {
	return new Uint8Array(data)
}

function encodeEntries(entries: string[], currentData = new Uint8Array(ICF_BLOCK_SIZE)) {
	const encoded = encodeIcfEntries(entries, currentData)
	return typeof encoded[0] === "string" ? null : cloneIcfData(encoded[0] as Uint8Array)
}

/**
 * Converts encoder results into user-facing validation text.
 *
 * @param encoded Mixed encode result from the binary ICF codec.
 * @returns The first validation message with a line number.
 */
export function entryValidationMessage(encoded: ReturnType<typeof encodeIcfEntries>) {
	for (let index = 1; index < encoded.length; index++) {
		if (typeof encoded[index] === "string") {
			return `Line ${index + 1}: ${encoded[index]}`
		}
	}

	return typeof encoded[0] === "string" ? `Line 1: ${encoded[0]}` : ""
}

/**
 * Creates the initial empty ICF editor state.
 *
 * @returns Valid one-header ICF data and decoded entries.
 */
export function createDefaultIcfState(): IcfEditorState {
	const data = encodeEntries(DEFAULT_ICF_ENTRIES) ?? new Uint8Array(ICF_BLOCK_SIZE)
	return { data, entries: decodeIcfEntries(data), error: "", warning: "" }
}

/**
 * Restores editor state from localStorage.
 *
 * @param stored Serialized hex string, or null when no state exists.
 * @returns Valid editor state, falling back to default data on invalid storage.
 */
export function readStoredIcfState(stored: string | null): IcfEditorState {
	const fallback = createDefaultIcfState()
	if (!stored) {
		return fallback
	}

	const bytes = hexToBin(stored)
	if (!bytes) {
		return { ...fallback, error: "Saved ICF state invalid" }
	}

	return {
		data: bytes,
		entries: decodeIcfEntries(bytes),
		error: "",
		warning: getIcfSanityError(bytes) ?? ""
	}
}

/**
 * Serializes the editor bytes for localStorage.
 *
 * @param state Current ICF editor state.
 * @returns Hex encoded ICF bytes.
 */
export function serializeIcfState(state: IcfEditorState) {
	return binToHex(state.data)
}

/**
 * Imports decoded ICF bytes into editor state.
 *
 * @param data ICF bytes in decrypted editor form.
 * @param warning Optional non-blocking validation warning.
 * @returns Editor state ready for React rendering.
 */
export function importIcfData(data: Uint8Array, warning = ""): IcfEditorState {
	const next = cloneIcfData(data)
	return {
		data: next,
		entries: decodeIcfEntries(next),
		error: "",
		warning
	}
}

function importDecodableIcfData(data: Uint8Array, warning = "") {
	const entries = decodeIcfEntries(data)
	const encoded = encodeIcfEntries(entries, data)
	const nextData = typeof encoded[0] === "string" ? data : cloneIcfData(encoded[0] as Uint8Array)
	return importIcfData(nextData, warning)
}

/**
 * Loads ICF bytes that may be decrypted, encrypted, or damaged but decodable.
 *
 * @param bytes File bytes read through Electron.
 * @returns Editor state plus a status message describing the load path.
 */
export async function loadIcfBytes(bytes: Uint8Array): Promise<LoadedIcfBytes> {
	const directWarning = getIcfSanityError(bytes)
	if (!directWarning) {
		return { state: importIcfData(bytes), status: "Loaded decrypted ICF." }
	}

	const decrypted = await decryptIcf(bytes)
	if (decrypted && !getIcfSanityError(decrypted)) {
		return { state: importIcfData(decrypted), status: "Loaded encrypted ICF." }
	}

	if (decrypted && decrypted.length >= ICF_BLOCK_SIZE) {
		return {
			state: importDecodableIcfData(decrypted, getIcfSanityError(decrypted) ?? directWarning),
			status: "Loaded encrypted ICF with warnings."
		}
	}

	if (bytes.length >= ICF_BLOCK_SIZE) {
		return { state: importDecodableIcfData(bytes, directWarning), status: "Loaded ICF with warnings." }
	}

	return {
		state: { ...createDefaultIcfState(), error: directWarning, warning: "" },
		status: ""
	}
}

/**
 * Applies edits from the line-based ICF entry editor.
 *
 * @param current Current editor state.
 * @param value Raw textarea value.
 * @returns Next editor state with validation errors or updated bytes.
 */
export function applyIcfEntriesChange(current: IcfEditorState, value: string): IcfEditorState {
	const entries = value.split("\n").map(line => line.trim())

	if (entries.length === 0) {
		entries.push("")
	}

	const encoded = encodeIcfEntries(entries, current.data)
	if (typeof encoded[0] === "string") {
		return {
			...current,
			entries,
			error: entryValidationMessage(encoded)
		}
	}

	return {
		data: cloneIcfData(encoded[0] as Uint8Array),
		entries,
		error: "",
		warning: ""
	}
}

/**
 * Applies edits from the hex dump editor.
 *
 * @param current Current editor state.
 * @param value Raw xxd-style dump text.
 * @param showDecryptedDump Whether the dump is currently shown decrypted.
 * @returns Next editor state with decoded bytes or an error.
 */
export async function applyIcfDumpChange(current: IcfEditorState, value: string, showDecryptedDump: boolean): Promise<IcfEditorState> {
	const decoded = xxdDecode(value)
	if (!decoded) {
		return { ...current, error: "Malformed Hex Dump" }
	}

	let data: Uint8Array<ArrayBufferLike> = decoded
	if (!showDecryptedDump) {
		const decrypted = await decryptIcf(decoded)
		if (!decrypted) {
			return { ...current, error: "Malformed Hex Dump" }
		}
		data = decrypted
	} else if (getIcfSanityError(decoded)) {
		const decrypted = await decryptIcf(decoded)
		if (decrypted && !getIcfSanityError(decrypted)) {
			data = decrypted
		}
	}

	return importIcfData(cloneIcfData(data), getIcfSanityError(data) ?? "")
}

/**
 * Renders the editor bytes into the current hex dump mode.
 *
 * @param state Current editor state.
 * @param showDecryptedDump Whether to render decrypted or encrypted bytes.
 * @returns xxd-style dump text.
 */
export async function renderIcfDump(state: IcfEditorState, showDecryptedDump: boolean) {
	if (showDecryptedDump) {
		return xxdEncode(state.data)
	}

	const encrypted = await encryptIcf(state.data)
	return xxdEncode(encrypted ?? state.data)
}

/**
 * Builds the encrypted payload used by the native Save ICF dialog.
 *
 * @param state Current editor state.
 * @returns Save payload, or a validation error when entries cannot encode.
 */
export async function createIcfSavePayload(state: IcfEditorState) {
	const encoded = encodeIcfEntries(state.entries, state.data)
	if (typeof encoded[0] === "string") {
		return { error: entryValidationMessage(encoded), data: null, encrypted: null, defaultName: null }
	}

	const data = cloneIcfData(encoded[0] as Uint8Array)
	const encrypted = await encryptIcf(data)
	if (!encrypted) {
		return { error: "could not encrypt ICF", data: null, encrypted: null, defaultName: null }
	}

	return {
		error: "",
		data,
		encrypted,
		defaultName: inferIcfFilename(data) ?? "ICF1"
	}
}
