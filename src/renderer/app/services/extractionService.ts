import type { ReadableByteSource } from "../../../fsdecrypt/byte-source"
import type { FscryptBootId } from "../../../fsdecrypt/fsdecrypt"
import type { NtfsExtractionWriter } from "../../../fsdecrypt/ntfs"
import type { VhdNtfsSource } from "../../../fsdecrypt/vhd"
import { throwIfAborted } from "../../base/common/cancellation"
import { outputSegmentsForFolder, sanitizePathSegment, stripExtension } from "../../base/common/path"
import { PickedFile, byteSourceFromPickedFile } from "../../electron-api"
import type { CompletedResult, MergeSelectionGroup, OptionVhdSource, RunStats } from "../common/appTypes"
import { createFolderWriter, vhdDetails } from "./extractionWriter"
import { filesystemFromBootSector } from "./selectionService"

export type ExtractionServiceContext = {
	outputRoot: string
	keySource?: ReadableByteSource
	optionFiles: PickedFile[]
	appendLog: (message: string) => void
	setProgress: (progress: number) => void
	setRunStats: (updater: (current: RunStats) => RunStats) => void
}

type ElapsedDetails = () => CompletedResult["details"]

async function extractNtfsSource(
	context: ExtractionServiceContext,
	ntfsSource: VhdNtfsSource,
	folderName: string,
	getExtraDetails: ElapsedDetails,
	signal: AbortSignal,
	onBytesWritten: (bytes: number) => void
): Promise<CompletedResult> {
	const { extractNtfsContents } = await import("../../../fsdecrypt/ntfs")
	const outputSegments = outputSegmentsForFolder(context.outputRoot, folderName)
	if (outputSegments.length > 0) {
		await window.fsdecryptGUI.prepareOutputFolder(context.outputRoot, outputSegments)
	}
	let totalBytes = 1
	const writer = createFolderWriter(context.outputRoot, folderName, () => totalBytes, context.setProgress, signal, onBytesWritten)
	const extracted = await extractNtfsContents(ntfsSource, writer, {
		onLog: context.appendLog,
		onTotalBytes: (bytes: number) => {
			totalBytes = bytes
			context.setRunStats(current => ({ ...current, totalBytes: bytes }))
		},
		signal
	})
	return {
		outputFolder: sanitizePathSegment(folderName),
		outputSegments,
		outputRoot: context.outputRoot,
		outputSize: extracted.bytes,
		details: [
			...getExtraDetails(),
			...vhdDetails(ntfsSource),
			{ label: "Files", value: extracted.files.toLocaleString() },
			{ label: "Folders", value: extracted.directories.toLocaleString() }
		]
	}
}

export async function runBaseExport(
	context: ExtractionServiceContext,
	file: PickedFile,
	elapsedDetails: ElapsedDetails,
	signal: AbortSignal,
	onBytesWritten: (bytes: number) => void
) {
	throwIfAborted(signal)
	const [{ extractInternalVhdSource }, { openVhdChainNtfsSource }] = await Promise.all([
		import("../../../fsdecrypt/ntfs"),
		import("../../../fsdecrypt/vhd")
	])
	context.appendLog(`Opening APP container ${file.name}`)
	const vhdSource = await extractInternalVhdSource(byteSourceFromPickedFile(file), {
		keyFile: context.keySource,
		onLog: context.appendLog
	})
	throwIfAborted(signal)
	const ntfsSource = await openVhdChainNtfsSource([vhdSource], { onLog: context.appendLog })
	return extractNtfsSource(context, ntfsSource, stripExtension(file.name), elapsedDetails, signal, onBytesWritten)
}

export async function runOptionExport(
	context: ExtractionServiceContext,
	file: PickedFile,
	elapsedDetails: ElapsedDetails,
	signal: AbortSignal,
	onBytesWritten: (bytes: number) => void
) {
	throwIfAborted(signal)
	const { FSCRYPT_CONTAINER_TYPE, describeContainerType, openFscryptSource } = await import("../../../fsdecrypt/fsdecrypt")
	const optionSource = await openFscryptSource(byteSourceFromPickedFile(file), {
		expectedContainerType: FSCRYPT_CONTAINER_TYPE.OPTION,
		keyFile: context.keySource,
		onLog: context.appendLog
	})
	const fileSystem = filesystemFromBootSector(await optionSource.read(0, 512))
	if (!fileSystem) {
		throw new Error(`${optionSource.outputFilename} is not an exFAT or NTFS image`)
	}

	context.appendLog(`Detected ${fileSystem} filesystem in ${optionSource.outputFilename}`)

	const folderName = stripExtension(file.name)
	const outputFolderName = sanitizePathSegment(folderName)
	const resultOutputSegments = outputSegmentsForFolder(context.outputRoot, outputFolderName)
	const optionRootPrefix = ["option", optionSource.bootId.targetOption]
	let totalBytes = Math.max(optionSource.size, 1)
	let expandedContainerCount = 0
	let expandedContainerBytes = 0
	const nestedTotals = { files: 0, directories: 0, bytes: 0 }
	const setTotalBytes = (bytes: number) => {
		totalBytes = Math.max(bytes, 1)
		context.setRunStats(current => ({ ...current, totalBytes }))
	}
	const adjustTotalBytes = (delta: number) => setTotalBytes(totalBytes + delta)
	const nestedExtractionOptions = (replacedBytes = 0) => {
		let reportedBytes = 0
		return {
			onLog: context.appendLog,
			onTotalBytes: (bytes: number) => {
				adjustTotalBytes(bytes - reportedBytes - replacedBytes)
				reportedBytes = bytes
				replacedBytes = 0
			},
			signal
		}
	}
	setTotalBytes(totalBytes)
	const createLazyFolderWriter = (writerFolderName: string): NtfsExtractionWriter & { outputSegments: string[]; outputFolder: string } => {
		const outputFolder = sanitizePathSegment(writerFolderName)
		const outputSegments = outputSegmentsForFolder(context.outputRoot, outputFolder)
		const writer = createFolderWriter(context.outputRoot, outputFolder, () => totalBytes, context.setProgress, signal, onBytesWritten)
		let prepared = false
		const prepare = async () => {
			if (prepared) return
			prepared = true
			if (outputSegments.length > 0) {
				await window.fsdecryptGUI.prepareOutputFolder(context.outputRoot, outputSegments)
			}
		}
		return {
			outputFolder,
			outputSegments,
			createDirectory: async path => {
				await prepare()
				await writer.createDirectory(path)
			},
			writeFile: async (path, source) => {
				await prepare()
				await writer.writeFile(path, source)
			}
		}
	}
	const prefixWriter = (baseWriter: NtfsExtractionWriter, prefix: string[]): NtfsExtractionWriter => ({
		createDirectory: path => baseWriter.createDirectory([...prefix, ...path]),
		writeFile: (path, source) => baseWriter.writeFile([...prefix, ...path], source)
	})
	const writer = prefixWriter(createLazyFolderWriter(folderName), optionRootPrefix)
	let optionVhdSourcesPromise: Promise<OptionVhdSource[]> | undefined
	const collectOptionVhdSources = async () => {
		optionVhdSourcesPromise ??= (async () => {
			const { openFscryptSource: openSource } = await import("../../../fsdecrypt/fsdecrypt")
			const collected: OptionVhdSource[] = []
			const collectFromOption = async (source: ReadableByteSource) => {
				const candidateOption = await openSource(source, {
					expectedContainerType: FSCRYPT_CONTAINER_TYPE.OPTION,
					keyFile: context.keySource,
					onLog: context.appendLog
				})
				const candidateFileSystem = filesystemFromBootSector(await candidateOption.read(0, 512))
				if (!candidateFileSystem) {
					throw new Error(`${candidateOption.outputFilename} is not an exFAT or NTFS image`)
				}
				const collector: NtfsExtractionWriter = {
					createDirectory: async () => {},
					writeFile: async (_path, childSource) => {
						if (childSource.name.toLowerCase().endsWith(".opt")) {
							await collectFromOption(childSource)
							return
						}
						if (childSource.name.toLowerCase().endsWith(".vhd")) {
							collected.push(
								Object.assign(childSource, {
									optionGameId: candidateOption.bootId.gameId,
									optionSequenceNumber: candidateOption.bootId.sequenceNumber
								})
							)
						}
					}
				}
				const options = { signal }
				if (candidateFileSystem === "NTFS") {
					await (await import("../../../fsdecrypt/ntfs")).extractNtfsContents(candidateOption, collector, options)
				} else {
					await (await import("../../../fsdecrypt/exfat")).extractExfatContents(candidateOption, collector, options)
				}
			}
			const files = context.optionFiles.some(candidate => candidate.path === file.path) ? context.optionFiles : [...context.optionFiles, file]
			for (const candidate of files) {
				await collectFromOption(byteSourceFromPickedFile(candidate))
			}
			return collected
		})()
		return optionVhdSourcesPromise
	}
	const extractOptionSource = async (
		nestedOptionSource: ReadableByteSource & { bootId?: FscryptBootId },
		targetWriter: NtfsExtractionWriter,
		depth: number,
		replacedBytes = 0
	) => {
		const nestedFileSystem = filesystemFromBootSector(await nestedOptionSource.read(0, 512))
		if (!nestedFileSystem) {
			throw new Error(`${nestedOptionSource.name} is not an exFAT or NTFS image`)
		}

		context.appendLog(`Detected ${nestedFileSystem} filesystem in ${nestedOptionSource.name}`)
		const nestedWriter = createOptionExpandingWriter(targetWriter, depth, false, nestedOptionSource.bootId)
		const nestedOptions = nestedExtractionOptions(replacedBytes)
		return nestedFileSystem === "NTFS"
			? await (await import("../../../fsdecrypt/ntfs")).extractNtfsContents(nestedOptionSource, nestedWriter, nestedOptions)
			: await (await import("../../../fsdecrypt/exfat")).extractExfatContents(nestedOptionSource, nestedWriter, nestedOptions)
	}
	const expandVhdSource = async (
		source: ReadableByteSource,
		targetWriter: NtfsExtractionWriter,
		depth: number,
		optionBootId?: FscryptBootId
	) => {
		const [{ extractNtfsContents }, { openVhdChainNtfsSource }] = await Promise.all([
			import("../../../fsdecrypt/ntfs"),
			import("../../../fsdecrypt/vhd")
		])
		let vhdNtfsSource: VhdNtfsSource
		try {
			vhdNtfsSource = await openVhdChainNtfsSource([source], { onLog: context.appendLog })
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("parent/base")) {
				throw error
			}
			const candidateVhds = (await collectOptionVhdSources())
				.filter(candidate => {
					const sameSource = candidate.name === source.name && candidate.size === source.size
					const sameGame = !optionBootId || candidate.optionGameId === optionBootId.gameId
					return !sameSource && sameGame
				})
				.sort((left, right) => (left.optionSequenceNumber ?? 0) - (right.optionSequenceNumber ?? 0))
			context.appendLog(`Linking VHD ${source.name} with ${candidateVhds.length.toLocaleString()} selected OPTION VHD parent layer(s)`)
			vhdNtfsSource = await openVhdChainNtfsSource([...candidateVhds, source], { onLog: context.appendLog })
		}
		return extractNtfsContents(vhdNtfsSource, createOptionExpandingWriter(targetWriter, depth), nestedExtractionOptions(source.size))
	}
	const createOptionExpandingWriter = (
		baseWriter: NtfsExtractionWriter,
		depth: number,
		skipRootCreate = false,
		optionBootId?: FscryptBootId
	): NtfsExtractionWriter => ({
		createDirectory: path => {
			if (skipRootCreate && path.length === 0) {
				return Promise.resolve()
			}
			return baseWriter.createDirectory(path)
		},
		writeFile: async (path, source) => {
			if (depth === 0 && path.length === 1 && source.name.toLowerCase().endsWith(".opt")) {
				context.appendLog(`Expanding nested OPTION ${path.join("/")}`)
				const nestedOptionSource = await openFscryptSource(source, {
					expectedContainerType: FSCRYPT_CONTAINER_TYPE.OPTION,
					keyFile: context.keySource,
					onLog: context.appendLog
				})
				const nestedResult = await extractOptionSource(nestedOptionSource, baseWriter, depth + 1, source.size)
				expandedContainerCount += 1
				expandedContainerBytes += source.size
				nestedTotals.files += nestedResult.files
				nestedTotals.directories += nestedResult.directories
				nestedTotals.bytes += nestedResult.bytes
				return
			}

			if (depth < 4 && source.name.toLowerCase().endsWith(".vhd")) {
				context.appendLog(`Expanding VHD ${path.join("/")}`)
				const targetWriter =
					depth > 0 && path.length === 1 && /^internal_\d+\.vhd$/i.test(source.name)
						? prefixWriter(baseWriter, ["App"])
						: path.length > 1
							? prefixWriter(baseWriter, path.slice(0, -1))
							: baseWriter
				const nestedResult = await expandVhdSource(source, targetWriter, depth + 1, optionBootId)
				expandedContainerCount += 1
				expandedContainerBytes += source.size
				nestedTotals.files += nestedResult.files
				nestedTotals.directories += nestedResult.directories
				nestedTotals.bytes += nestedResult.bytes
				return
			}

			await baseWriter.writeFile(path, source)
		}
	})
	const extractionOptions = {
		onLog: context.appendLog,
		onTotalBytes: setTotalBytes,
		signal
	}
	const extracted =
		fileSystem === "NTFS"
			? await (await import("../../../fsdecrypt/ntfs")).extractNtfsContents(optionSource, createOptionExpandingWriter(writer, 0, true, optionSource.bootId), extractionOptions)
			: await (await import("../../../fsdecrypt/exfat")).extractExfatContents(optionSource, createOptionExpandingWriter(writer, 0, true, optionSource.bootId), extractionOptions)
	const displayedFiles = extracted.files - expandedContainerCount + nestedTotals.files
	const displayedDirectories = extracted.directories + nestedTotals.directories
	const displayedBytes = extracted.bytes - expandedContainerBytes + nestedTotals.bytes
	return {
		outputFolder: outputFolderName,
		outputSegments: resultOutputSegments,
		outputRoot: context.outputRoot,
		outputSize: displayedBytes,
		details: [
			...elapsedDetails(),
			{ label: "Type", value: describeContainerType(optionSource.bootId.containerType) },
			{ label: "Filesystem", value: fileSystem },
			{ label: "Game", value: optionSource.bootId.gameId },
			{ label: "Option", value: optionSource.bootId.targetOption },
			{ label: "Files", value: displayedFiles.toLocaleString() },
			{ label: "Folders", value: displayedDirectories.toLocaleString() }
		]
	}
}

export async function runMergeExport(
	context: ExtractionServiceContext,
	group: MergeSelectionGroup,
	elapsedDetails: ElapsedDetails,
	signal: AbortSignal,
	onBytesWritten: (bytes: number) => void
) {
	throwIfAborted(signal)
	const [{ appContainersToVhdSources }, { openVhdChainNtfsSource }] = await Promise.all([
		import("../../../fsdecrypt/ntfs"),
		import("../../../fsdecrypt/vhd")
	])
	const appFiles = group.files.filter(file => file.name.toLowerCase().endsWith(".app"))
	const rawVhdFiles = group.files.filter(file => !file.name.toLowerCase().endsWith(".app"))
	const appVhds =
		appFiles.length > 0
			? await appContainersToVhdSources(appFiles.map(byteSourceFromPickedFile), { keyFile: context.keySource, onLog: context.appendLog })
			: []
	throwIfAborted(signal)
	const ntfsSource = await openVhdChainNtfsSource([...rawVhdFiles.map(byteSourceFromPickedFile), ...appVhds], { onLog: context.appendLog })
	const topName = group.files.length > 0 ? group.files[group.files.length - 1].name : ntfsSource.name
	return extractNtfsSource(context, ntfsSource, stripExtension(topName), elapsedDetails, signal, onBytesWritten)
}
