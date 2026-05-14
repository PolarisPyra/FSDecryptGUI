import { ReadableByteSource } from "./byte-source"

const EXFAT_OEM_ID = "EXFAT   "
const EXFAT_ENTRY_END = 0x00
const EXFAT_ENTRY_FILE = 0x85
const EXFAT_ENTRY_STREAM = 0xc0
const EXFAT_ENTRY_FILENAME = 0xc1
const EXFAT_FILE_ATTRIBUTE_DIRECTORY = 0x10
const EXFAT_NO_FAT_CHAIN = 0x02
const EXFAT_CLUSTER_FIRST = 2
const EXFAT_CLUSTER_END = 0xfffffff8
const EXFAT_DIRECTORY_ENTRY_SIZE = 32
const EXTRACTION_CONCURRENCY = 4
const LARGE_FILE_THRESHOLD = 64 * 1024 * 1024
const EXTRACTION_READ_CHUNK_SIZE = 1024 * 1024
const EXTRACTION_PROGRESS_LOG_INTERVAL = 16 * 1024 * 1024

export type ExfatExtractionWriter = {
	createDirectory: (path: string[]) => Promise<void>
	writeFile: (path: string[], source: ReadableByteSource) => Promise<void>
}

export type ExfatExtractionResult = {
	files: number
	directories: number
	bytes: number
}

type ExfatExtractionOptions = {
	onLog?: (message: string) => void
	onTotalBytes?: (bytes: number) => void
	onExtractedBytes?: (bytes: number) => void
	signal?: AbortSignal
	fileConcurrency?: number
}

type ExfatContext = {
	source: ReadableByteSource
	bytesPerSector: number
	clusterSize: number
	fatOffset: number
	clusterHeapOffset: number
	clusterCount: number
	rootDirectoryCluster: number
	clusterCache: Map<number, number[]>
}

type ExfatEntry = {
	name: string
	firstCluster: number
	size: number
	noFatChain: boolean
	isDirectory: boolean
}

type ExtractionPlan = {
	directories: string[][]
	files: Array<{ path: string[]; entry: ExfatEntry }>
	bytes: number
}

type ExtractionReadProgress = {
	signal?: AbortSignal
	onBytes?: (bytes: number) => void
	onLog?: (message: string) => void
	path?: string[]
	size?: number
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

function readU64(bytes: Uint8Array, offset: number) {
	const value = view(bytes).getBigUint64(offset, true)
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error("exFAT file size is too large for browser processing")
	}

	return Number(value)
}

function decodeUtf16(bytes: Uint8Array, offset: number, codeUnits: number) {
	return new TextDecoder("utf-16le").decode(bytes.slice(offset, offset + codeUnits * 2))
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

function yieldToUi() {
	return new Promise<void>(resolve => {
		globalThis.setTimeout(resolve, 0)
	})
}

function createExtractionReadProgress(
	options: ExfatExtractionOptions,
	path: string[],
	size: number
): ExtractionReadProgress | undefined {
	if (!options.onExtractedBytes && !options.onLog && !options.signal) {
		return undefined
	}

	let readBytes = 0
	let nextLogAt = EXTRACTION_PROGRESS_LOG_INTERVAL
	const pathText = path.join("/")

	return {
		signal: options.signal,
		path,
		size,
		onBytes: bytes => {
			if (bytes <= 0) {
				return
			}

			readBytes += bytes
			options.onExtractedBytes?.(bytes)

			if (size >= LARGE_FILE_THRESHOLD && readBytes >= nextLogAt) {
				const percent = Math.min(100, (readBytes / size) * 100).toFixed(1)
				options.onLog?.(`Reading ${pathText}: ${readBytes.toLocaleString()}/${size.toLocaleString()} bytes (${percent}%)`)
				while (readBytes >= nextLogAt) {
					nextLogAt += EXTRACTION_PROGRESS_LOG_INTERVAL
				}
			}
		}
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

function clusterOffset(ctx: ExfatContext, cluster: number) {
	if (cluster < EXFAT_CLUSTER_FIRST || cluster >= ctx.clusterCount + EXFAT_CLUSTER_FIRST) {
		throw new Error(`Invalid exFAT cluster ${cluster}`)
	}

	return ctx.clusterHeapOffset + (cluster - EXFAT_CLUSTER_FIRST) * ctx.clusterSize
}

async function readExfatBoot(source: ReadableByteSource): Promise<ExfatContext> {
	const boot = await source.read(0, 512)
	if (readAscii(boot.slice(3, 11)) !== EXFAT_OEM_ID) {
		throw new Error(`${source.name} is not an exFAT image`)
	}

	const bytesPerSector = 1 << boot[0x6c]
	const sectorsPerCluster = 1 << boot[0x6d]
	const clusterSize = bytesPerSector * sectorsPerCluster
	const fatOffset = readU32(boot, 0x50) * bytesPerSector
	const clusterHeapOffset = readU32(boot, 0x58) * bytesPerSector
	const clusterCount = readU32(boot, 0x5c)
	const rootDirectoryCluster = readU32(boot, 0x60)

	if (bytesPerSector <= 0 || clusterSize <= 0 || clusterCount <= 0 || rootDirectoryCluster < EXFAT_CLUSTER_FIRST) {
		throw new Error(`${source.name} has invalid exFAT geometry`)
	}

	return {
		source,
		bytesPerSector,
		clusterSize,
		fatOffset,
		clusterHeapOffset,
		clusterCount,
		rootDirectoryCluster,
		clusterCache: new Map()
	}
}

async function readFatEntry(ctx: ExfatContext, cluster: number) {
	const entry = await ctx.source.read(ctx.fatOffset + cluster * 4, 4)
	return readU32(entry, 0)
}

async function clusterChain(ctx: ExfatContext, firstCluster: number, size: number, noFatChain: boolean) {
	if (firstCluster === 0 || size === 0) {
		return []
	}

	const cached = ctx.clusterCache.get(firstCluster)
	if (cached) {
		return cached
	}

	const clustersNeeded = Math.max(1, Math.ceil(size / ctx.clusterSize))
	const clusters: number[] = []

	if (noFatChain) {
		for (let index = 0; index < clustersNeeded; index++) {
			clusters.push(firstCluster + index)
		}
	} else {
		let cluster = firstCluster
		const visited = new Set<number>()

		while (cluster >= EXFAT_CLUSTER_FIRST && cluster < EXFAT_CLUSTER_END) {
			if (visited.has(cluster)) {
				throw new Error("Loop detected in exFAT cluster chain")
			}
			visited.add(cluster)
			clusters.push(cluster)

			if (clusters.length >= clustersNeeded) {
				break
			}
			cluster = await readFatEntry(ctx, cluster)
		}
	}

	for (const cluster of clusters) {
		clusterOffset(ctx, cluster)
	}
	ctx.clusterCache.set(firstCluster, clusters)
	return clusters
}

async function readClusterStream(ctx: ExfatContext, firstCluster: number, size: number, noFatChain: boolean) {
	const output = new Uint8Array(size)
	const clusters = await clusterChain(ctx, firstCluster, size, noFatChain)
	let outputOffset = 0

	for (const cluster of clusters) {
		const chunkSize = Math.min(ctx.clusterSize, size - outputOffset)
		if (chunkSize <= 0) {
			break
		}
		output.set(await ctx.source.read(clusterOffset(ctx, cluster), chunkSize), outputOffset)
		outputOffset += chunkSize
	}

	return output
}

function sourceFromClusterStream(
	ctx: ExfatContext,
	name: string,
	firstCluster: number,
	size: number,
	noFatChain: boolean,
	progress?: ExtractionReadProgress
): ReadableByteSource {
	return {
		name,
		size,
		read: async (offset, length) => {
			throwIfAborted(progress?.signal)
			const cappedLength = Math.min(length, size - offset)
			if (cappedLength <= 0) {
				return new Uint8Array()
			}

			const output = new Uint8Array(cappedLength)
			const clusters = await clusterChain(ctx, firstCluster, size, noFatChain)
			let outputOffset = 0
			let streamOffset = 0

			for (const cluster of clusters) {
				throwIfAborted(progress?.signal)
				const clusterEnd = streamOffset + ctx.clusterSize
				if (offset < clusterEnd && offset + cappedLength > streamOffset) {
					const withinCluster = Math.max(0, offset - streamOffset)
					const copyLength = Math.min(ctx.clusterSize - withinCluster, cappedLength - outputOffset)
					let copiedFromCluster = 0

					while (copiedFromCluster < copyLength) {
						throwIfAborted(progress?.signal)
						const chunkLength = progress
							? Math.min(EXTRACTION_READ_CHUNK_SIZE, copyLength - copiedFromCluster)
							: copyLength - copiedFromCluster
						output.set(
							await ctx.source.read(clusterOffset(ctx, cluster) + withinCluster + copiedFromCluster, chunkLength),
							outputOffset
						)
						outputOffset += chunkLength
						copiedFromCluster += chunkLength
						progress?.onBytes?.(chunkLength)

						if (progress) {
							await yieldToUi()
						}
					}

					if (outputOffset >= cappedLength) {
						break
					}
				}
				streamOffset = clusterEnd
			}

			return output
		}
	}
}

async function readDirectoryEntries(
	ctx: ExfatContext,
	firstCluster: number,
	size: number | undefined,
	noFatChain: boolean
): Promise<ExfatEntry[]> {
	const directoryBytes =
		size === undefined
			? await readRootDirectory(ctx, firstCluster)
			: await readClusterStream(ctx, firstCluster, size, noFatChain)
	const entries: ExfatEntry[] = []

	for (
		let offset = 0;
		offset + EXFAT_DIRECTORY_ENTRY_SIZE <= directoryBytes.length;
		offset += EXFAT_DIRECTORY_ENTRY_SIZE
	) {
		const entryType = directoryBytes[offset]
		if (entryType === EXFAT_ENTRY_END) {
			break
		}
		if (entryType !== EXFAT_ENTRY_FILE) {
			continue
		}

		const secondaryCount = directoryBytes[offset + 1]
		const fileAttributes = readU16(directoryBytes, offset + 4)
		const secondaryStart = offset + EXFAT_DIRECTORY_ENTRY_SIZE
		const secondaryEnd = secondaryStart + secondaryCount * EXFAT_DIRECTORY_ENTRY_SIZE
		if (secondaryEnd > directoryBytes.length) {
			break
		}

		const streamOffset = secondaryStart
		if (directoryBytes[streamOffset] !== EXFAT_ENTRY_STREAM) {
			offset = secondaryEnd - EXFAT_DIRECTORY_ENTRY_SIZE
			continue
		}

		const generalFlags = directoryBytes[streamOffset + 1]
		const nameLength = directoryBytes[streamOffset + 3]
		const firstCluster = readU32(directoryBytes, streamOffset + 20)
		const dataLength = readU64(directoryBytes, streamOffset + 24)
		let name = ""

		for (
			let nameOffset = streamOffset + EXFAT_DIRECTORY_ENTRY_SIZE;
			nameOffset < secondaryEnd && directoryBytes[nameOffset] === EXFAT_ENTRY_FILENAME;
			nameOffset += EXFAT_DIRECTORY_ENTRY_SIZE
		) {
			name += decodeUtf16(directoryBytes, nameOffset + 2, 15)
		}

		name = sanitizePathSegment(name.slice(0, nameLength).replace(/\0+$/g, ""))
		if (name.length > 0) {
			entries.push({
				name,
				firstCluster,
				size: dataLength,
				noFatChain: (generalFlags & EXFAT_NO_FAT_CHAIN) !== 0,
				isDirectory: (fileAttributes & EXFAT_FILE_ATTRIBUTE_DIRECTORY) !== 0
			})
		}

		offset = secondaryEnd - EXFAT_DIRECTORY_ENTRY_SIZE
	}

	return entries
}

async function readRootDirectory(ctx: ExfatContext, firstCluster: number) {
	const chunks: Uint8Array[] = []
	let totalLength = 0
	let cluster = firstCluster
	const visited = new Set<number>()

	while (cluster >= EXFAT_CLUSTER_FIRST && cluster < EXFAT_CLUSTER_END) {
		if (visited.has(cluster)) {
			throw new Error("Loop detected in exFAT root directory")
		}
		visited.add(cluster)

		const chunk = await ctx.source.read(clusterOffset(ctx, cluster), ctx.clusterSize)
		chunks.push(chunk)
		totalLength += chunk.length
		if (chunk.some((value, index) => index % EXFAT_DIRECTORY_ENTRY_SIZE === 0 && value === EXFAT_ENTRY_END)) {
			break
		}

		cluster = await readFatEntry(ctx, cluster)
	}

	const output = new Uint8Array(totalLength)
	let offset = 0
	for (const chunk of chunks) {
		output.set(chunk, offset)
		offset += chunk.length
	}
	return output
}

async function planDirectory(
	ctx: ExfatContext,
	firstCluster: number,
	size: number | undefined,
	noFatChain: boolean,
	path: string[],
	plan: ExtractionPlan,
	options: ExfatExtractionOptions
) {
	throwIfAborted(options.signal)
	const entries = await readDirectoryEntries(ctx, firstCluster, size, noFatChain)

	for (const entry of entries) {
		throwIfAborted(options.signal)
		const childPath = [...path, entry.name]
		if (entry.isDirectory) {
			plan.directories.push(childPath)
			await planDirectory(ctx, entry.firstCluster, entry.size, entry.noFatChain, childPath, plan, options)
			continue
		}

		plan.files.push({ path: childPath, entry })
		plan.bytes += entry.size
	}
}

async function extractPlan(
	ctx: ExfatContext,
	writer: ExfatExtractionWriter,
	plan: ExtractionPlan,
	result: ExfatExtractionResult,
	options: ExfatExtractionOptions
) {
	await runLimited(plan.directories, options.fileConcurrency ?? EXTRACTION_CONCURRENCY, async directoryPath => {
		throwIfAborted(options.signal)
		if (directoryPath.length < 2) {
			options.onLog?.(`Creating folder ${directoryPath.join("/")}`)
		}
		await writer.createDirectory(directoryPath)
		result.directories += 1
	})

	const smallFiles = plan.files.filter(file => file.entry.size < LARGE_FILE_THRESHOLD)
	const largeFiles = plan.files.filter(file => file.entry.size >= LARGE_FILE_THRESHOLD)

	for (const { path: filePath, entry } of largeFiles) {
		throwIfAborted(options.signal)
		const fileSource = sourceFromClusterStream(
			ctx,
			entry.name,
			entry.firstCluster,
			entry.size,
			entry.noFatChain,
			createExtractionReadProgress(options, filePath, entry.size)
		)
		if (fileSource.size >= 1024 * 1024) {
			options.onLog?.(`Extracting ${filePath.join("/")} (${fileSource.size.toLocaleString()} bytes)`)
		}
		await writer.writeFile(filePath, fileSource)
		result.files += 1
		result.bytes += fileSource.size
	}

	await runLimited(smallFiles, options.fileConcurrency ?? EXTRACTION_CONCURRENCY, async ({ path: filePath, entry }) => {
		throwIfAborted(options.signal)
		const fileSource = sourceFromClusterStream(
			ctx,
			entry.name,
			entry.firstCluster,
			entry.size,
			entry.noFatChain,
			createExtractionReadProgress(options, filePath, entry.size)
		)
		if (fileSource.size >= 1024 * 1024) {
			options.onLog?.(`Extracting ${filePath.join("/")} (${fileSource.size.toLocaleString()} bytes)`)
		}
		await writer.writeFile(filePath, fileSource)
		result.files += 1
		result.bytes += fileSource.size
	})
}

export async function extractExfatContents(
	source: ReadableByteSource,
	writer: ExfatExtractionWriter,
	options: ExfatExtractionOptions = {}
): Promise<ExfatExtractionResult> {
	options.onLog?.(`Opening exFAT contents from ${source.name}`)
	throwIfAborted(options.signal)
	const ctx = await readExfatBoot(source)
	const result = { files: 0, directories: 0, bytes: 0 }
	options.onLog?.(`Using up to ${(options.fileConcurrency ?? EXTRACTION_CONCURRENCY).toString()} concurrent file extract(s)`)
	throwIfAborted(options.signal)
	options.onLog?.("Building exFAT extraction plan")
	const plan: ExtractionPlan = { directories: [], files: [], bytes: 0 }
	await planDirectory(ctx, ctx.rootDirectoryCluster, undefined, false, [], plan, options)
	options.onLog?.(
		`Planned ${plan.files.length.toLocaleString()} file(s), ${plan.directories.length.toLocaleString()} folder(s), ${plan.bytes.toLocaleString()} bytes`
	)
	options.onTotalBytes?.(plan.bytes)
	await writer.createDirectory([])
	await extractPlan(ctx, writer, plan, result, options)
	options.onLog?.(
		`Extracted ${result.files.toLocaleString()} file(s), ${result.directories.toLocaleString()} folder(s), ${result.bytes.toLocaleString()} bytes`
	)
	return result
}
