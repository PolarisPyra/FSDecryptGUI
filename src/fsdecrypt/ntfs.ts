import { ReadableByteSource } from "./byte-source"
import { FSCRYPT_CONTAINER_TYPE, FscryptBootId, FscryptInput, openFscryptSource } from "./fsdecrypt"

const FILE_MAGIC = "FILE"
const INDX_MAGIC = "INDX"
const NTFS_OEM_ID = "NTFS    "
const NTFS_ATTR_DATA = 0x80
const NTFS_ATTR_INDEX_ROOT = 0x90
const NTFS_ATTR_INDEX_ALLOCATION = 0xa0
const NTFS_ATTR_END = 0xffffffff
const NTFS_ROOT_RECORD = 5
const NTFS_FILE_ATTRIBUTE_DIRECTORY = 0x10000000
const NTFS_FILE_RECORD_DIRECTORY = 0x02
const EXTRACTION_CONCURRENCY = 4

type LocalOutputSink = {
	write: (chunk: Uint8Array) => Promise<void>
	close: () => Promise<void>
}

export type AppVhdChainOptions = {
	keyFile?: FscryptInput
	output?: LocalOutputSink | ((filename: string) => Promise<LocalOutputSink | undefined>)
	onProgress?: (progress: number) => void
	onLog?: (message: string) => void
}

type NtfsBoot = {
	bytesPerSector: number
	clusterSize: number
	mftOffset: number
	recordSize: number
}

type NtfsRun = {
	lcn: number
	length: number
}

type DataAttribute =
	| { resident: true; value: Uint8Array }
	| { resident: false; runs: NtfsRun[]; realSize: number; initializedSize: number }

type IndexEntry = {
	fileReference: number
	name: string
	size: number
	namespace: number
	fileFlags: number
}

type NtfsContext = {
	source: ReadableByteSource
	boot: NtfsBoot
	mftRuns: NtfsRun[]
	recordCache: Map<number, Uint8Array>
}

export type InternalVhdSource = ReadableByteSource & {
	bootId: FscryptBootId
	appName: string
	internalName: string
}

export type NtfsExtractionWriter = {
	createDirectory: (path: string[]) => Promise<void>
	writeFile: (path: string[], source: ReadableByteSource) => Promise<void>
}

export type NtfsExtractionResult = {
	files: number
	directories: number
	bytes: number
}

type NtfsExtractionOptions = {
	onLog?: (message: string) => void
	signal?: AbortSignal
	fileConcurrency?: number
}

function readAscii(bytes: Uint8Array) {
	return new TextDecoder("ascii").decode(bytes)
}

function view(bytes: Uint8Array) {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function readU16(bytes: Uint8Array, offset: number) {
	return view(bytes).getUint16(offset, true)
}

function readU32(bytes: Uint8Array, offset: number) {
	return view(bytes).getUint32(offset, true)
}

function readI8(bytes: Uint8Array, offset: number) {
	return view(bytes).getInt8(offset)
}

function readU64(bytes: Uint8Array, offset: number) {
	return view(bytes).getBigUint64(offset, true)
}

function checkedNumber(value: bigint, label: string) {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(`${label} is too large for browser processing`)
	}

	return Number(value)
}

function decodeUtf16(bytes: Uint8Array, offset: number, codeUnits: number) {
	return new TextDecoder("utf-16le").decode(bytes.slice(offset, offset + codeUnits * 2))
}

function appVhdName(appName: string) {
	return appName.replace(/\.[^.]+$/, "") + ".vhd"
}

function sanitizePathSegment(name: string) {
	return Array.from(name, character => {
		const code = character.charCodeAt(0)
		return code < 32 || '<>:"/\\|?*'.includes(character) ? "_" : character
	}).join("")
}

function throwIfAborted(signal: AbortSignal | undefined) {
	if (signal?.aborted) {
		throw new DOMException("Extraction cancelled", "AbortError")
	}
}

async function runLimited<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
	let nextIndex = 0
	const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
		while (nextIndex < items.length) {
			const item = items[nextIndex++]
			await worker(item)
		}
	})

	await Promise.all(workers)
}

async function readNtfsBoot(source: ReadableByteSource): Promise<NtfsBoot> {
	const boot = await source.read(0, 512)
	if (readAscii(boot.slice(3, 11)) !== NTFS_OEM_ID) {
		throw new Error(`${source.name} is not an NTFS image`)
	}

	const bytesPerSector = readU16(boot, 0x0b)
	const sectorsPerCluster = boot[0x0d]
	const clusterSize = bytesPerSector * sectorsPerCluster
	const mftLcn = checkedNumber(readU64(boot, 0x30), "$MFT LCN")
	const recordSizeByte = readI8(boot, 0x40)
	const recordSize = recordSizeByte < 0 ? 1 << -recordSizeByte : recordSizeByte * clusterSize

	if (bytesPerSector <= 0 || clusterSize <= 0 || recordSize <= 0) {
		throw new Error(`${source.name} has invalid NTFS geometry`)
	}

	return { bytesPerSector, clusterSize, mftOffset: mftLcn * clusterSize, recordSize }
}

function applyFixup(record: Uint8Array, bytesPerSector: number, magic: string) {
	if (readAscii(record.slice(0, 4)) !== magic) {
		throw new Error(`Invalid NTFS ${magic} record`)
	}

	const updateSequenceOffset = readU16(record, 4)
	const updateSequenceCount = readU16(record, 6)
	const fixupStride =
		updateSequenceCount > 1 && record.length % (updateSequenceCount - 1) === 0
			? record.length / (updateSequenceCount - 1)
			: bytesPerSector

	for (let index = 1; index < updateSequenceCount; index++) {
		const sectorEnd = index * fixupStride - 2
		const updateOffset = updateSequenceOffset + index * 2
		if (sectorEnd + 1 >= record.length || updateOffset + 1 >= record.length) {
			throw new Error("Invalid NTFS update sequence")
		}
		record[sectorEnd] = record[updateOffset]
		record[sectorEnd + 1] = record[updateOffset + 1]
	}

	return record
}

function parseRuns(bytes: Uint8Array) {
	const runs: NtfsRun[] = []
	let offset = 0
	let currentLcn = 0

	while (offset < bytes.length && bytes[offset] !== 0) {
		const header = bytes[offset++]
		const lengthSize = header & 0x0f
		const offsetSize = header >> 4
		let length = 0
		let lcnDelta = 0

		for (let index = 0; index < lengthSize; index++) {
			length += bytes[offset++] * 2 ** (index * 8)
		}

		if (offsetSize > 0) {
			for (let index = 0; index < offsetSize; index++) {
				lcnDelta += bytes[offset++] * 2 ** (index * 8)
			}
			const signBit = 2 ** (offsetSize * 8 - 1)
			if (lcnDelta >= signBit) {
				lcnDelta -= 2 ** (offsetSize * 8)
			}
			currentLcn += lcnDelta
		}

		runs.push({ lcn: offsetSize === 0 ? -1 : currentLcn, length })
	}

	return runs
}

async function readRuns(
	source: ReadableByteSource,
	runs: NtfsRun[],
	clusterSize: number,
	offset: number,
	length: number
) {
	const output = new Uint8Array(length)
	let outputOffset = 0
	let runStart = 0

	for (const run of runs) {
		const runBytes = run.length * clusterSize
		const runEnd = runStart + runBytes

		if (offset < runEnd && offset + length > runStart) {
			const withinRun = Math.max(0, offset - runStart)
			const copyLength = Math.min(runBytes - withinRun, length - outputOffset)

			if (run.lcn >= 0) {
				output.set(await source.read(run.lcn * clusterSize + withinRun, copyLength), outputOffset)
			}

			outputOffset += copyLength
			if (outputOffset >= length) {
				break
			}
		}

		runStart = runEnd
	}

	return output
}

function parseDataAttribute(record: Uint8Array, offset: number): DataAttribute {
	const nonResident = record[offset + 8] !== 0

	if (!nonResident) {
		const valueLength = readU32(record, offset + 0x10)
		const valueOffset = readU16(record, offset + 0x14)
		return { resident: true, value: record.slice(offset + valueOffset, offset + valueOffset + valueLength) }
	}

	const runListOffset = readU16(record, offset + 0x20)
	const realSize = checkedNumber(readU64(record, offset + 0x30), "NTFS file size")
	const initializedSize = checkedNumber(readU64(record, offset + 0x38), "NTFS initialized size")
	const attributeLength = readU32(record, offset + 4)
	return {
		resident: false,
		runs: parseRuns(record.slice(offset + runListOffset, offset + attributeLength)),
		realSize,
		initializedSize
	}
}

function attributes(record: Uint8Array) {
	const result: Array<{ type: number; offset: number; length: number }> = []
	let offset = readU16(record, 0x14)

	while (offset + 8 <= record.length) {
		const type = readU32(record, offset)
		if (type === NTFS_ATTR_END) {
			break
		}

		const length = readU32(record, offset + 4)
		if (length <= 0 || offset + length > record.length) {
			break
		}

		result.push({ type, offset, length })
		offset += length
	}

	return result
}

async function readFileRecord(ctx: NtfsContext, recordNumber: number) {
	const cached = ctx.recordCache.get(recordNumber)
	if (cached) {
		return cached
	}

	const bytes =
		recordNumber === 0
			? await ctx.source.read(ctx.boot.mftOffset, ctx.boot.recordSize)
			: await readRuns(ctx.source, ctx.mftRuns, ctx.boot.clusterSize, recordNumber * ctx.boot.recordSize, ctx.boot.recordSize)
	const fixed = applyFixup(bytes, ctx.boot.bytesPerSector, FILE_MAGIC)
	ctx.recordCache.set(recordNumber, fixed)
	return fixed
}

async function buildNtfsContext(source: ReadableByteSource): Promise<NtfsContext> {
	const boot = await readNtfsBoot(source)
	const recordZero = applyFixup(await source.read(boot.mftOffset, boot.recordSize), boot.bytesPerSector, FILE_MAGIC)
	const mftData = attributes(recordZero).find(attr => attr.type === NTFS_ATTR_DATA)

	if (!mftData) {
		throw new Error(`${source.name} has no $MFT data attribute`)
	}

	const data = parseDataAttribute(recordZero, mftData.offset)
	if (data.resident) {
		throw new Error(`${source.name} has unsupported resident $MFT data`)
	}

	return { source, boot, mftRuns: data.runs, recordCache: new Map([[0, recordZero]]) }
}

function parseIndexEntries(bytes: Uint8Array, start: number, end: number) {
	const entries: IndexEntry[] = []
	let offset = start

	while (offset + 0x52 <= bytes.length && offset < end) {
		const entryLength = readU16(bytes, offset + 8)
		const streamLength = readU16(bytes, offset + 10)
		const flags = readU32(bytes, offset + 12)

		if (entryLength < 0x10 || offset + entryLength > bytes.length) {
			break
		}

		if ((flags & 0x02) === 0 && streamLength >= 0x42) {
			const fileReference = checkedNumber(readU64(bytes, offset) & 0x0000ffffffffffffn, "NTFS file reference")
			const filenameOffset = offset + 0x10
			const fileFlags = readU32(bytes, filenameOffset + 0x38)
			const nameLength = bytes[filenameOffset + 0x40]
			const namespace = bytes[filenameOffset + 0x41]
			const name = decodeUtf16(bytes, filenameOffset + 0x42, nameLength)
			const size = checkedNumber(readU64(bytes, filenameOffset + 0x30), `${name} size`)
			entries.push({ fileReference, name, size, namespace, fileFlags })
		}

		if ((flags & 0x02) !== 0) {
			break
		}

		offset += entryLength
	}

	return entries
}

function parseIndexRootEntries(value: Uint8Array) {
	const indexBlockSize = readU32(value, 8)
	const entriesOffset = readU32(value, 0x10)
	const totalSize = readU32(value, 0x14)
	return {
		indexBlockSize,
		entries: parseIndexEntries(value, 0x10 + entriesOffset, 0x10 + totalSize)
	}
}

async function parseIndexAllocationEntries(ctx: NtfsContext, data: DataAttribute, indexBlockSize: number) {
	if (data.resident) {
		return []
	}

	const entries: IndexEntry[] = []
	const allocationSize = Math.min(data.initializedSize || data.realSize, data.realSize)

	for (let offset = 0; offset + indexBlockSize <= allocationSize; offset += indexBlockSize) {
		const block = await readRuns(ctx.source, data.runs, ctx.boot.clusterSize, offset, indexBlockSize)
		if (readAscii(block.slice(0, 4)) !== INDX_MAGIC) {
			continue
		}

		applyFixup(block, ctx.boot.bytesPerSector, INDX_MAGIC)
		const entriesOffset = readU32(block, 0x18)
		const totalSize = readU32(block, 0x1c)
		entries.push(...parseIndexEntries(block, 0x18 + entriesOffset, 0x18 + totalSize))
	}

	return entries
}

async function findRootEntry(ctx: NtfsContext, filename: string) {
	const entries = await readDirectoryEntries(ctx, NTFS_ROOT_RECORD)
	return entries.find(entry => entry.name.toLowerCase() === filename.toLowerCase())
}

async function readDirectoryEntries(ctx: NtfsContext, recordNumber: number) {
	const directoryRecord = await readFileRecord(ctx, recordNumber)
	const attrs = attributes(directoryRecord)
	const indexRoot = attrs.find(attr => attr.type === NTFS_ATTR_INDEX_ROOT)

	if (!indexRoot) {
		throw new Error(`${ctx.source.name} has no directory index`)
	}

	const rootData = parseDataAttribute(directoryRecord, indexRoot.offset)
	if (!rootData.resident) {
		throw new Error(`${ctx.source.name} has unsupported non-resident directory index`)
	}

	const { indexBlockSize, entries } = parseIndexRootEntries(rootData.value)
	const indexAllocation = attrs.find(attr => attr.type === NTFS_ATTR_INDEX_ALLOCATION)
	if (indexAllocation) {
		entries.push(...(await parseIndexAllocationEntries(ctx, parseDataAttribute(directoryRecord, indexAllocation.offset), indexBlockSize)))
	}

	return entries
}

function sourceFromDataAttribute(
	name: string,
	source: ReadableByteSource,
	boot: NtfsBoot,
	data: DataAttribute,
	sizeHint: number
): ReadableByteSource {
	const size = data.resident ? data.value.length : data.realSize || sizeHint
	return {
		name,
		size,
		read: async (offset, length) => {
			const cappedLength = Math.min(length, size - offset)
			if (cappedLength <= 0) {
				return new Uint8Array()
			}

			if (data.resident) {
				return data.value.slice(offset, offset + cappedLength)
			}

			return readRuns(source, data.runs, boot.clusterSize, offset, cappedLength)
		}
	}
}

function dataSourceFromAttribute(
	appName: string,
	bootId: FscryptBootId,
	internalName: string,
	source: ReadableByteSource,
	boot: NtfsBoot,
	data: DataAttribute,
	sizeHint: number
): InternalVhdSource {
	return {
		...sourceFromDataAttribute(appVhdName(appName), source, boot, data, sizeHint),
		bootId,
		appName,
		internalName
	}
}

function isSystemEntry(entry: IndexEntry) {
	return (
		entry.namespace === 2 ||
		entry.name === "." ||
		entry.name === ".." ||
		entry.name === "System Volume Information" ||
		entry.name.startsWith("$")
	)
}

function isDirectoryRecord(record: Uint8Array) {
	return (readU16(record, 0x16) & NTFS_FILE_RECORD_DIRECTORY) !== 0
}

async function extractDirectory(
	ctx: NtfsContext,
	writer: NtfsExtractionWriter,
	recordNumber: number,
	path: string[],
	visited: Set<number>,
	result: NtfsExtractionResult,
	options: NtfsExtractionOptions
) {
	throwIfAborted(options.signal)
	if (visited.has(recordNumber)) {
		return
	}
	visited.add(recordNumber)

	const entries = await readDirectoryEntries(ctx, recordNumber)
	const seenNames = new Set<string>()
	const childEntries: Array<{ entry: IndexEntry; safeName: string; childPath: string[] }> = []

	for (const entry of entries) {
		throwIfAborted(options.signal)
		if (isSystemEntry(entry)) {
			continue
		}

		const safeName = sanitizePathSegment(entry.name)
		const nameKey = safeName.toLowerCase()
		if (seenNames.has(nameKey)) {
			continue
		}
		seenNames.add(nameKey)

		const childPath = [...path, safeName]
		childEntries.push({ entry, safeName, childPath })
	}

	await runLimited(childEntries, options.fileConcurrency ?? EXTRACTION_CONCURRENCY, async ({ entry, safeName, childPath }) => {
		throwIfAborted(options.signal)
		const childRecord = await readFileRecord(ctx, entry.fileReference)
		const isDirectory = isDirectoryRecord(childRecord) || (entry.fileFlags & NTFS_FILE_ATTRIBUTE_DIRECTORY) !== 0

		if (isDirectory) {
			if (path.length < 2) {
				options.onLog?.(`Creating folder ${childPath.join("/")}`)
			}
			await writer.createDirectory(childPath)
			result.directories += 1
			await extractDirectory(ctx, writer, entry.fileReference, childPath, visited, result, options)
			return
		}

		const dataAttr = attributes(childRecord).find(attr => attr.type === NTFS_ATTR_DATA)
		if (!dataAttr) {
			return
		}

		const data = parseDataAttribute(childRecord, dataAttr.offset)
		const fileSource = sourceFromDataAttribute(safeName, ctx.source, ctx.boot, data, entry.size)
		if (fileSource.size >= 1024 * 1024) {
			options.onLog?.(`Extracting ${childPath.join("/")} (${fileSource.size.toLocaleString()} bytes)`)
		}
		await writer.writeFile(childPath, fileSource)
		result.files += 1
		result.bytes += fileSource.size
	})
}

async function scanDirectoryBytes(
	ctx: NtfsContext,
	recordNumber: number,
	visited: Set<number>,
	options: NtfsExtractionOptions
): Promise<number> {
	throwIfAborted(options.signal)
	if (visited.has(recordNumber)) {
		return 0
	}
	visited.add(recordNumber)

	let totalBytes = 0
	const entries = await readDirectoryEntries(ctx, recordNumber)
	const childEntries = entries.filter(entry => !isSystemEntry(entry))

	await runLimited(childEntries, options.fileConcurrency ?? EXTRACTION_CONCURRENCY, async entry => {
		throwIfAborted(options.signal)
		const childRecord = await readFileRecord(ctx, entry.fileReference)
		const isDirectory = isDirectoryRecord(childRecord) || (entry.fileFlags & NTFS_FILE_ATTRIBUTE_DIRECTORY) !== 0

		if (isDirectory) {
			totalBytes += await scanDirectoryBytes(ctx, entry.fileReference, visited, options)
			return
		}

		const dataAttr = attributes(childRecord).find(attr => attr.type === NTFS_ATTR_DATA)
		if (!dataAttr) {
			return
		}

		const data = parseDataAttribute(childRecord, dataAttr.offset)
		const fileSize = data.resident ? data.value.length : data.realSize || entry.size
		totalBytes += fileSize
	})

	return totalBytes
}

export async function extractNtfsContents(
	source: ReadableByteSource,
	writer: NtfsExtractionWriter,
	options: NtfsExtractionOptions = {}
): Promise<NtfsExtractionResult> {
	options.onLog?.(`Opening NTFS contents from ${source.name}`)
	throwIfAborted(options.signal)
	const ctx = await buildNtfsContext(source)
	const result = { files: 0, directories: 0, bytes: 0 }
	options.onLog?.(`Using up to ${(options.fileConcurrency ?? EXTRACTION_CONCURRENCY).toString()} concurrent file extract(s)`)
	throwIfAborted(options.signal)
	await writer.createDirectory([])
	await extractDirectory(ctx, writer, NTFS_ROOT_RECORD, [], new Set(), result, options)
	options.onLog?.(
		`Extracted ${result.files.toLocaleString()} file(s), ${result.directories.toLocaleString()} folder(s), ${result.bytes.toLocaleString()} bytes`
	)
	return result
}

export async function scanNtfsBytes(
	source: ReadableByteSource,
	options: NtfsExtractionOptions = {}
): Promise<number> {
	options.onLog?.(`Scanning NTFS contents from ${source.name}`)
	throwIfAborted(options.signal)
	const ctx = await buildNtfsContext(source)
	const totalBytes = await scanDirectoryBytes(ctx, NTFS_ROOT_RECORD, new Set(), options)
	options.onLog?.(`Scanned total of ${totalBytes.toLocaleString()} bytes`)
	return totalBytes
}

export async function extractInternalVhdSource(
	appFile: FscryptInput,
	options: { keyFile?: FscryptInput; onLog?: (message: string) => void } = {}
): Promise<InternalVhdSource> {
	const plaintext = await openFscryptSource(appFile, options)
	if (
		plaintext.bootId.containerType !== FSCRYPT_CONTAINER_TYPE.APP &&
		plaintext.bootId.containerType !== FSCRYPT_CONTAINER_TYPE.OS
	) {
		throw new Error(`${appFile.name} is not an APP/OS container with an internal VHD`)
	}

	const internalName = `internal_${plaintext.bootId.sequenceNumber}.vhd`
	options.onLog?.(`Opening decrypted NTFS from ${appFile.name}`)
	const ctx = await buildNtfsContext(plaintext)
	options.onLog?.(`Looking for ${internalName} in ${appFile.name}`)
	const entry = await findRootEntry(ctx, internalName)

	if (!entry) {
		throw new Error(`Could not find ${internalName} inside ${appFile.name}`)
	}

	const record = await readFileRecord(ctx, entry.fileReference)
	const dataAttr = attributes(record).find(attr => attr.type === NTFS_ATTR_DATA)
	if (!dataAttr) {
		throw new Error(`${internalName} has no data stream`)
	}

	options.onLog?.(`Found ${internalName} (${entry.size.toLocaleString()} bytes)`)
	return dataSourceFromAttribute(appFile.name, plaintext.bootId, internalName, plaintext, ctx.boot, parseDataAttribute(record, dataAttr.offset), entry.size)
}

export async function appContainersToVhdSources(
	files: FscryptInput[],
	options: { keyFile?: FscryptInput; onLog?: (message: string) => void } = {}
) {
	const extracted = await Promise.all(files.map(file => extractInternalVhdSource(file, options)))
	extracted.sort((left, right) => left.bootId.sequenceNumber - right.bootId.sequenceNumber)
	return extracted
}
