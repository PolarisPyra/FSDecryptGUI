import aesjs from "aes-js"

import type { PickedFile } from "../../electron-api"
import type { SelectionQueues } from "./selectionQueue"

const ICF_KEY_HEX = "09ca5efd30c9aaef3804d0a7e3fa7120"
const ICF_IV_HEX = "b155c22c2e7f0491fa7f0fdc217aff90"
const ICF_BLOCK_SIZE = 0x40
const HEX = "0123456789abcdef"

let crcTable: Int32Array | null = null

export type EncodedEntry = Uint8Array | string

export type IcfGenerationIssue = {
	source: string
	message: string
}

type IcfGenerationBase = {
	entries: string[]
	errors: IcfGenerationIssue[]
	warnings: IcfGenerationIssue[]
}

export type IcfGenerationResult =
	| (IcfGenerationBase & {
			ok: true
			header: string
			data: Uint8Array
			sourceCount: number
	  })
	| (IcfGenerationBase & {
			ok: false
	  })

export function listIcfGameIds(queues: SelectionQueues) {
	const gameIds = new Set<string>()

	for (const group of [...queues.container.groups, ...queues.vhd.groups]) {
		if (!group.selected) continue
		for (const layer of group.appLayers) {
			if (layer.bootId?.gameId) {
				gameIds.add(layer.bootId.gameId)
			}
		}
	}

	for (const group of queues.option.groups) {
		if (!group.selected) continue
		for (const layer of group.optionLayers) {
			if (layer.bootId?.gameId) {
				gameIds.add(layer.bootId.gameId)
			}
		}
	}

	return [...gameIds].sort()
}

export function hexToBin(text: string) {
	const normalized = text.trim()
	if (normalized.length % 2 !== 0) {
		return null
	}

	const result = new Uint8Array(normalized.length >> 1)
	for (let i = 0; i < result.length; i++) {
		const value = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16)
		if (Number.isNaN(value)) {
			return null
		}
		result[i] = value
	}
	return result
}

export function binToHex(bytes: Uint8Array) {
	let result = ""
	for (let i = 0; i < bytes.length; i++) {
		const value = bytes[i]
		result += HEX[value >> 4] + HEX[value & 0xf]
	}
	return result
}

function getIv() {
	return hexToBin(ICF_IV_HEX)!
}

function getKey() {
	return hexToBin(ICF_KEY_HEX)!
}

function dec2(value: number) {
	return value < 10 ? `0${value}` : String(value)
}

function dec4(value: number) {
	if (value < 10) return `000${value}`
	if (value < 100) return `00${value}`
	if (value < 1000) return `0${value}`
	return String(value)
}

function versionText(version: { major: number; minor: number; release: number }, zeroPadMajor = false) {
	const major = zeroPadMajor ? dec4(version.major) : String(version.major)
	return `${major}.${dec2(version.minor)}.${dec2(version.release)}`
}

function timestampText(timestamp: { year: number; month: number; day: number; hour: number; minute: number; second: number }) {
	return `${dec4(timestamp.year)}${dec2(timestamp.month)}${dec2(timestamp.day)}${dec2(timestamp.hour)}${dec2(timestamp.minute)}${dec2(timestamp.second)}`
}

export function xxdEncode(bytes: Uint8Array, offset = 0, newline = "\n") {
	let result = ""
	const chars = new Array<number>(16)

	for (let ptr = 0; ptr < bytes.length; ptr += 16) {
		let label = (offset + ptr).toString(16)
		while (label.length < 4) {
			label = `0${label}`
		}

		result += `0000${label}: `
		for (let i = 0; i < 16; i += 2) {
			const a = bytes[ptr + i] ?? 0
			const b = bytes[ptr + i + 1] ?? 0
			result += `${HEX[a >> 4]}${HEX[a & 0xf]}${HEX[b >> 4]}${HEX[b & 0xf]} `
			chars[i] = a >= 0x20 && a <= 0x7e ? a : 0x2e
			chars[i + 1] = b >= 0x20 && b <= 0x7e ? b : 0x2e
		}
		result += ` ${String.fromCharCode(...chars)}${newline}`
	}

	return result
}

export function xxdDecode(text: string) {
	const lines = text.split("\n")
	let hexits = ""

	for (const rawLine of lines) {
		const line = rawLine.trim()
		if (!line) {
			continue
		}

		const colon = line.indexOf(":")
		if (colon === -1) {
			return null
		}

		const hexSection = line.slice(colon + 1, -16).trim()
		let hexCount = 0

		for (const char of hexSection) {
			if (char === " ") {
				continue
			}
			hexits += char
			hexCount++
		}

		if (hexCount !== 32) {
			return null
		}
	}

	return hexToBin(hexits)
}

export function crc32(data: Uint8Array, seed = 0) {
	if (!crcTable) {
		crcTable = new Int32Array(256)
		for (let i = 0; i < 256; i++) {
			let value = i
			for (let j = 0; j < 8; j++) {
				value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
			}
			crcTable[i] = value
		}
	}

	let crc = ~seed
	for (let i = 0; i < data.length; i++) {
		crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
	}
	return ~crc
}

export async function decryptIcf(data: Uint8Array) {
	if (data.length % 16 !== 0) {
		return null
	}

	try {
		const aesCbc = new aesjs.ModeOfOperation.cbc(getKey(), getIv())
		return aesCbc.decrypt(data)
	} catch {
		return null
	}
}

export async function encryptIcf(data: Uint8Array) {
	if (data.length % 16 !== 0) {
		return null
	}

	try {
		const aesCbc = new aesjs.ModeOfOperation.cbc(getKey(), getIv())
		return aesCbc.encrypt(data)
	} catch {
		return null
	}
}

export function getIcfSanityError(data: Uint8Array | null) {
	if (!data) {
		return "Invalid input"
	}

	if (data.length < ICF_BLOCK_SIZE) {
		return "Bad length"
	}

	const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
	if (view.getInt32(4, true) !== data.length) {
		return "Bad length"
	}

	if (crc32(data.subarray(4)) !== view.getInt32(0, true)) {
		return "Bad CRC"
	}

	const sectionCount = view.getUint16(0x10, true)
	const numSections = data.length / ICF_BLOCK_SIZE
	if (sectionCount !== numSections - 1) {
		return "Bad section count"
	}

	let sectionCrc = 0
	for (let i = 1; i < numSections; i++) {
		const section = data.subarray(i * ICF_BLOCK_SIZE, (i + 1) * ICF_BLOCK_SIZE)
		if (section[0] !== 2 || section[1] !== 1) {
			continue
		}
		sectionCrc ^= crc32(section)
	}

	if (view.getInt32(0x20, true) !== sectionCrc) {
		return "Bad section CRC"
	}

	return null
}

function decodeVersion(values: Uint8Array, zeroPad = false) {
	const major = (values[3] << 8) | values[2]
	const majorText = zeroPad ? dec4(major) : String(major)
	return `${majorText}.${dec2(values[1])}.${dec2(values[0])}`
}

function encodeVersion(text: string, values: Uint8Array) {
	const parts = text.split(".")
	if (parts.length !== 3) {
		return false
	}

	const major = Number.parseInt(parts[0], 10)
	const minor = Number.parseInt(parts[1], 10)
	const build = Number.parseInt(parts[2], 10)
	if ([major, minor, build].some(Number.isNaN)) {
		return false
	}

	values[0] = build
	values[1] = minor
	values[2] = major & 0xff
	values[3] = major >> 8
	return true
}

function decodeTime(values: Uint8Array) {
	const year = (values[1] << 8) | values[0]
	return `${dec4(year)}${dec2(values[2])}${dec2(values[3])}${dec2(values[4])}${dec2(values[5])}${dec2(values[6])}`
}

function encodeTime(text: string, values: Uint8Array) {
	if (text.length !== 14) {
		return false
	}

	const year = Number.parseInt(text.slice(0, 4), 10)
	const month = Number.parseInt(text.slice(4, 6), 10)
	const day = Number.parseInt(text.slice(6, 8), 10)
	const hour = Number.parseInt(text.slice(8, 10), 10)
	const minute = Number.parseInt(text.slice(10, 12), 10)
	const second = Number.parseInt(text.slice(12, 14), 10)

	if ([year, month, day, hour, minute, second].some(Number.isNaN)) {
		return false
	}

	values[0] = year & 0xff
	values[1] = year >> 8
	values[2] = month
	values[3] = day
	values[4] = hour
	values[5] = minute
	values[6] = second
	return true
}

function appPatchPartFromType(type: number) {
	if (type <= 1 || (type - 1) % 0x100 !== 0) {
		return null
	}

	return (type - 1) / 0x100
}

export function encodeIcfEntries(entries: string[], currentData: Uint8Array) {
	const data = new Uint8Array(entries.length * ICF_BLOCK_SIZE)
	const view = new DataView(data.buffer)
	const result: EncodedEntry[] = [data]

	const headerMatch = /^(\w{4})(\w{3})(\d)$/.exec(entries[0] ?? "")
	let gameId = "SXXX"
	let platformId = "AXX"
	let platformGeneration = -1

	if (headerMatch) {
		gameId = headerMatch[1]
		platformId = headerMatch[2]
		platformGeneration = Number.parseInt(headerMatch[3], 10)
	}

	let validCount = 0
	let systemVersion = new Uint8Array(4)
	let appPart = 0
	let appLastVersion = ""
	let appLastTime = new Uint8Array(8)
	const seenNames: Record<string, number> = {}
	let patchNumber = 0x001

	for (let i = 1; i < entries.length; i++) {
		const entry = entries[i]
		const base = i * ICF_BLOCK_SIZE
		const section = data.subarray(base, base + ICF_BLOCK_SIZE)
		const sectionView = new DataView(section.buffer, section.byteOffset, section.byteLength)
		const version = section.subarray(0x20, 0x24)
		const time = section.subarray(0x24, 0x2c)
		const platformVersion = section.subarray(0x2c, 0x30)
		const baseVersion = section.subarray(0x30, 0x34)
		const baseTime = section.subarray(0x34, 0x3c)

		if (entry?.startsWith("!")) {
			const oldData = currentData.subarray(base, base + ICF_BLOCK_SIZE)
			result[i] = xxdEncode(oldData, base)
			continue
		}

		const matches = /^([A-Z]+)_([^_]+)_(\d+)_(\d+)(_[^_]+)?\.(\w+)$/.exec(entry ?? "")
		if (!matches) {
			result[i] = "Malformed entry filename"
			continue
		}

		const [, entryGameId, dataName, timestamp, partRaw, baseNameRaw, typeName] = matches
		const part = Number.parseInt(partRaw, 10)
		const baseName = baseNameRaw ? baseNameRaw.slice(1) : null

		if (seenNames[entry]) {
			result[i] = "Duplicate entry?"
			continue
		}
		seenNames[entry] = i

		sectionView.setUint16(0, 0x102, true)
		if (!encodeTime(timestamp, time)) {
			result[i] = "Malformed timestamp"
			continue
		}

		switch (typeName) {
			case "pack":
				sectionView.setUint32(4, 0, true)
				if (entryGameId !== platformId) {
					result[i] = `Platform ID mismatch: ${platformId} expected`
					continue
				}
				if (part !== 0 || baseName) {
					result[i] = "SYSTEM image may not be layered"
					continue
				}
				if (systemVersion.some(Boolean)) {
					result[i] = "Redundant SYSTEM image"
					continue
				}
				if (!encodeVersion(dataName, version)) {
					result[i] = "Malformed version"
					continue
				}
				systemVersion = version.slice()
				platformVersion.set(systemVersion)
				break
			case "app":
				sectionView.setUint32(4, 1, true)
				if (entryGameId !== gameId) {
					result[i] = `Game ID mismatch: ${gameId} expected`
					continue
				}
				const standalonePatch = part > 0 && appPart === 0 && Boolean(baseName)
				if (part !== appPart && !standalonePatch) {
					result[i] = `APP index out of order: part ${appPart} expected`
					continue
				}
				if ((part === 0 && baseName) || (part !== 0 && !baseName) || (part !== 0 && !standalonePatch && baseName !== appLastVersion)) {
					result[i] = "APP base image mismatch"
					continue
				}
				if (!encodeVersion(dataName, version)) {
					result[i] = "Malformed version"
					continue
				}
				platformVersion.set(systemVersion)
				if (part > 0) {
					patchNumber = part * 0x100 + 1
					sectionView.setUint32(4, patchNumber, true)
					encodeVersion(baseName!, baseVersion)
					if (!standalonePatch) {
						baseTime.set(appLastTime)
					}
				}
				appPart = part + 1
				appLastVersion = dataName
				appLastTime = time.slice()
				break
			case "opt":
				sectionView.setUint32(4, 2, true)
				if (entryGameId !== gameId) {
					result[i] = `Game ID mismatch: ${gameId} expected`
					continue
				}
				if (part !== 0 || baseName) {
					result[i] = "OPT image may not be layered"
					continue
				}
				version[0] = dataName.charCodeAt(0) ?? 0
				version[1] = dataName.charCodeAt(1) ?? 0
				version[2] = dataName.charCodeAt(2) ?? 0
				version[3] = dataName.charCodeAt(3) ?? 0
				break
			default:
				result[i] = `Unknown file type: ${typeName}`
				continue
		}

		result[i] = section
		validCount++
	}

	if (validCount + 1 !== entries.length) {
		result[0] = "Invalid section(s) exists"
		return result
	}

	if (platformGeneration < 0) {
		result[0] = "Malformed header. Example: SDEZACA0"
		return result
	}

	view.setInt32(4, data.length, true)
	view.setUint16(0x10, validCount, true)

	const titleData = data.subarray(0x18, 0x20)
	titleData[0] = gameId.charCodeAt(0)
	titleData[1] = gameId.charCodeAt(1)
	titleData[2] = gameId.charCodeAt(2)
	titleData[3] = gameId.charCodeAt(3)
	titleData[4] = platformId.charCodeAt(0)
	titleData[5] = platformId.charCodeAt(1)
	titleData[6] = platformId.charCodeAt(2)
	titleData[7] = platformGeneration

	let sectionCrc = 0
	for (let i = 1; i < entries.length; i++) {
		sectionCrc ^= crc32(result[i] as Uint8Array)
	}

	view.setInt32(0x20, sectionCrc, true)
	view.setInt32(0, crc32(data.subarray(4)), true)
	result[0] = data
	return result
}

export function decodeIcfEntries(data: Uint8Array) {
	const entries: string[] = []
	const error = getIcfSanityError(data)
	let gameId = "SXXX"
	let platformId = "AXX"

	if (error && data.length < ICF_BLOCK_SIZE) {
		entries[0] = `! ${error}`
	} else {
		const header = data.subarray(0x18, 0x20)
		gameId = String.fromCharCode(header[0], header[1], header[2], header[3])
		platformId = String.fromCharCode(header[4], header[5], header[6])
		entries[0] = `${gameId}${platformId}${header[7]}`
	}

	const numSections = data.length / ICF_BLOCK_SIZE
	let systemVersion: number | null = null
	let appPart = 0
	let appLastVersion = ""
	let appLastTime = ""
	const seenNames: Record<string, number> = {}

	for (let i = 1; i < numSections; i++) {
		const section = data.subarray(i * ICF_BLOCK_SIZE, (i + 1) * ICF_BLOCK_SIZE)
		const view = new DataView(section.buffer, section.byteOffset, section.byteLength)
		const magic = view.getUint16(0, true)
		const type = view.getUint32(4, true)
		const version = section.subarray(0x20, 0x24)
		const time = section.subarray(0x24, 0x2c)
		const platformVersion = view.getUint32(0x2c, true)
		const baseVersion = section.subarray(0x30, 0x34)
		const baseTime = section.subarray(0x34, 0x3c)

		if (magic !== 0x102) {
			entries[i] = "! Invalid Magic"
			continue
		}

		let prefix = ""
		let suffix = ""
		let dataName = ""
		let baseName = ""
		const timestamp = decodeTime(time)

		switch (type) {
			case 0:
				suffix = "0.pack"
				prefix = platformId
				dataName = decodeVersion(version, true)
				if (systemVersion !== null) {
					entries[i] = "! Redundant SYSTEM image"
					continue
				}
				systemVersion = platformVersion
				break
			case 1:
				dataName = decodeVersion(version)
				appLastVersion = dataName
				appLastTime = timestamp
				if (systemVersion !== null && platformVersion !== systemVersion) {
					entries[i] = "! SYSTEM version mismatch"
					continue
				}
				prefix = gameId
				if (appPart) {
					entries[i] = "! Redundant base APP"
					continue
				}
				suffix = "0.app"
				break
			case 2:
				suffix = "0.opt"
				prefix = gameId
				dataName = String.fromCharCode(...Array.from(version))
				break
			default: {
				const patchPart = appPatchPartFromType(type)
				if (patchPart !== null) {
					appPart = patchPart
					dataName = decodeVersion(version)
					baseName = decodeVersion(baseVersion)
					if (appLastVersion && baseName !== appLastVersion) {
						appLastVersion = dataName
						entries[i] = `! Unable to locate base APP ${baseName}`
						continue
					}
					appLastVersion = dataName
					const decodedBaseTime = decodeTime(baseTime)
					if (appLastTime && decodedBaseTime !== appLastTime) {
						appLastTime = timestamp
						entries[i] = "! Base APP timestamp mismatch"
						continue
					}
					appLastTime = timestamp
					suffix = `${appPart}_${baseName}.app`
					if (systemVersion !== null && platformVersion !== systemVersion) {
						entries[i] = "! SYSTEM version mismatch"
						continue
					}
					prefix = gameId
					break
				}

				entries[i] = `! Unknown Type: ${type.toString(16)}`
				continue
			}
		}

		entries[i] = `${prefix}_${dataName}_${timestamp}_${suffix}`
		if (seenNames[entries[i]]) {
			entries[i] = "! Duplicate entry?"
			continue
		}
		seenNames[entries[i]] = i
	}

	return entries
}

export function inferIcfFilename(data: Uint8Array) {
	if (getIcfSanityError(data)) {
		return null
	}

	const header = data.subarray(0x18, 0x20)
	const gameId = String.fromCharCode(header[0], header[1], header[2], header[3])
	const platformId = String.fromCharCode(header[4], header[5], header[6])
	let romVersion = ""
	let dataVersion = ""
	const numSections = data.length / ICF_BLOCK_SIZE

	for (let i = 1; i < numSections; i++) {
		const section = data.subarray(i * ICF_BLOCK_SIZE, (i + 1) * ICF_BLOCK_SIZE)
		const view = new DataView(section.buffer, section.byteOffset, section.byteLength)
		if (view.getUint16(0, true) !== 0x102) {
			continue
		}

		const type = view.getUint32(4, true)
		const version = section.subarray(0x20, 0x24)
		switch (type) {
			case 1:
				romVersion = decodeVersion(version)
				break
			case 2: {
				const current = String.fromCharCode(...Array.from(version))
				if (current.localeCompare(dataVersion) > 0) {
					dataVersion = current
				}
				break
			}
			default:
				if (appPatchPartFromType(type) !== null) {
					romVersion = decodeVersion(version)
				}
				break
		}
	}

	return `${gameId}_${platformId}_${romVersion}${dataVersion ? `_${dataVersion}` : ""}`
}

function encodeCurrentEntries(entries: string[], currentData: Uint8Array) {
	const encoded = encodeIcfEntries(entries, currentData)
	if (typeof encoded[0] === "string") {
		return { error: encoded[0], data: null }
	}

	return { error: null, data: new Uint8Array(encoded[0] as Uint8Array) }
}

function comparePickedFile(left: PickedFile, right: PickedFile) {
	return left.path.localeCompare(right.path)
}

function appLayerSource(layer: NonNullable<SelectionQueues["container"]["groups"][number]["appLayers"][number]>) {
	if (!layer.bootId) {
		return `APP ${layer.file.name}`
	}

	return `APP ${layer.bootId.gameId} part ${layer.bootId.sequenceNumber} (${layer.file.name})`
}

function optionLayerSource(layer: NonNullable<SelectionQueues["option"]["groups"][number]["optionLayers"][number]>) {
	if (!layer.bootId) {
		return `OPT ${layer.file.name}`
	}

	return `OPT ${layer.bootId.gameId} ${layer.bootId.targetOption} (${layer.file.name})`
}

function rawVhdSource(files: PickedFile[], fallback: string) {
	if (files.length === 1) {
		return `VHD ${files[0].name}`
	}

	return fallback
}

function validateAppChain(
	label: string,
	layers: Array<NonNullable<SelectionQueues["container"]["groups"][number]["appLayers"][number]>>,
	errors: IcfGenerationIssue[]
) {
	const sequenceNumbers = layers.map(layer => layer.bootId?.sequenceNumber).filter((value): value is number => value !== undefined)
	if (sequenceNumbers.length === 0) return

	const highestSequence = Math.max(...sequenceNumbers)
	for (let index = 0; index <= highestSequence; index++) {
		if (!sequenceNumbers.includes(index)) {
			errors.push({ source: label, message: `APP chain must include parent/update part ${index}` })
		}
	}

	const duplicateSequence = sequenceNumbers.find((value, index) => sequenceNumbers.indexOf(value) !== index)
	if (duplicateSequence !== undefined) {
		errors.push({ source: label, message: `APP chain contains duplicate part ${duplicateSequence}` })
	}
}

export function generateIcfFromQueues(queues: SelectionQueues, targetGameId?: string): IcfGenerationResult {
	const errors: IcfGenerationIssue[] = []
	const warnings: IcfGenerationIssue[] = []
	const appLayersByPath = new Map<string, NonNullable<SelectionQueues["container"]["groups"][number]["appLayers"][number]>>()
	const optionLayersByPath = new Map<string, NonNullable<SelectionQueues["option"]["groups"][number]["optionLayers"][number]>>()

	for (const group of [...queues.container.groups, ...queues.vhd.groups]) {
		if (!group.selected) continue
		const matchingLayers = targetGameId ? group.appLayers.filter(layer => layer.bootId?.gameId === targetGameId) : group.appLayers
		if (targetGameId && matchingLayers.length === 0) continue
		const layersWithErrors = matchingLayers.filter(layer => layer.error)
		if (layersWithErrors.length === 0 && group.warning) {
			const warningLayers = matchingLayers.length > 0 ? matchingLayers : group.appLayers
			if (warningLayers.length > 0) {
				for (const layer of warningLayers) {
					warnings.push({ source: appLayerSource(layer), message: group.warning })
				}
			} else {
				warnings.push({ source: group.label, message: group.warning })
			}
		}
		if (group.rawVhds.length > 0 && group.appLayers.length === 0) {
			errors.push({ source: rawVhdSource(group.rawVhds, group.label), message: "raw VHD layers do not contain APP boot metadata for ICF" })
		}
		if (matchingLayers.length > 0) {
			validateAppChain(group.label, matchingLayers, errors)
			for (const layer of matchingLayers) {
				appLayersByPath.set(layer.file.path, layer)
			}
		}
	}

	for (const group of queues.option.groups) {
		if (!group.selected) continue
		const matchingLayers = targetGameId ? group.optionLayers.filter(layer => layer.bootId?.gameId === targetGameId) : group.optionLayers
		if (targetGameId && matchingLayers.length === 0) continue
		const layersWithErrors = matchingLayers.filter(layer => layer.error)
		if (layersWithErrors.length === 0 && group.warning) {
			const warningLayers = matchingLayers.length > 0 ? matchingLayers : group.optionLayers
			if (warningLayers.length > 0) {
				for (const layer of warningLayers) {
					warnings.push({ source: optionLayerSource(layer), message: group.warning })
				}
			} else {
				warnings.push({ source: group.label, message: group.warning })
			}
		}
		for (const layer of matchingLayers) {
			optionLayersByPath.set(layer.file.path, layer)
		}
	}

	const allAppLayers = [...appLayersByPath.values()]
	const allOptionLayers = [...optionLayersByPath.values()]
	const appLayers = allAppLayers.sort((left, right) => {
		const sequenceDelta = (left.bootId?.sequenceNumber ?? 0) - (right.bootId?.sequenceNumber ?? 0)
		return sequenceDelta || comparePickedFile(left.file, right.file)
	})
	const optionLayers = allOptionLayers.sort((left, right) => {
		const leftName = left.bootId?.targetOption ?? left.file.name
		const rightName = right.bootId?.targetOption ?? right.file.name
		return leftName.localeCompare(rightName) || comparePickedFile(left.file, right.file)
	})

	for (const layer of appLayers) {
		if (layer.error || !layer.bootId) {
			errors.push({ source: appLayerSource(layer), message: layer.error ?? "missing APP boot metadata" })
		}
	}

	for (const layer of optionLayers) {
		if (layer.error || !layer.bootId) {
			errors.push({ source: optionLayerSource(layer), message: layer.error ?? "missing OPT boot metadata" })
		} else if (layer.bootId.sequenceNumber !== 0) {
			errors.push({ source: optionLayerSource(layer), message: "layered OPT entries cannot be represented in ICF" })
		}
	}

	if (appLayers.length === 0) {
		errors.push({ source: "Selection", message: "select one complete parent APP chain before generating an ICF" })
	}

	if (optionLayers.length === 0) {
		errors.push({ source: "Selection", message: "select at least one OPT with the same game code as the APP" })
	}

	const bootIds = [...appLayers.map(layer => layer.bootId), ...optionLayers.map(layer => layer.bootId)].filter(Boolean)
	const gameIds = new Set(bootIds.map(bootId => bootId!.gameId).filter(Boolean))
	const platformIds = new Set(bootIds.map(bootId => bootId!.osId).filter(Boolean))

	if (gameIds.size > 1) {
		errors.push({ source: "Selection", message: `ICF can only describe one game ID. Found ${[...gameIds].join(", ")}` })
	}
	if (platformIds.size > 1) {
		errors.push({ source: "Selection", message: `ICF can only describe one platform ID. Found ${[...platformIds].join(", ")}` })
	}

	const gameId = [...gameIds][0]
	const platformId = [...platformIds][0]
	const header = gameId && platformId ? `${gameId}${platformId}0` : "SXXXACA0"
	const entries = [header]

	for (const layer of appLayers) {
		if (!layer.bootId) continue
		entries.push(layer.file.name)
	}

	for (const layer of optionLayers) {
		if (!layer.bootId) continue
		entries.push(layer.file.name)
	}

	if (errors.length > 0 || warnings.length > 0 || !gameId || !platformId) {
		if (!gameId) errors.push({ source: "Selection", message: "could not infer game ID from selected files" })
		if (!platformId) errors.push({ source: "Selection", message: "could not infer platform ID from selected files" })
		return { ok: false, errors, warnings, entries }
	}

	const encoded = encodeCurrentEntries(entries, new Uint8Array(ICF_BLOCK_SIZE))
	if (encoded.error || !encoded.data) {
		return { ok: false, errors: [{ source: "ICF", message: encoded.error ?? "could not encode ICF" }], warnings, entries }
	}

	return {
		ok: true,
		header,
		entries,
		errors,
		warnings,
		data: encoded.data,
		sourceCount: appLayers.length + optionLayers.length
	}
}
