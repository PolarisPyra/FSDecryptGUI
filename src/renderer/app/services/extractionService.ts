import type { ReadableByteSource } from "../../../fsdecrypt/byte-source"
import type { VhdNtfsSource } from "../../../fsdecrypt/vhd"
import { throwIfAborted } from "../../base/common/cancellation"
import { stripExtension } from "../../base/common/path"
import { PickedFile, byteSourceFromPickedFile } from "../../electron-api"
import type { CompletedResult, MergeSelectionGroup, RunStats } from "../common/appTypes"
import { createFolderWriter, createOutputFolderPlan, prepareOutputFolder, vhdDetails } from "./extractionWriter"

export type ExtractionServiceContext = {
	outputRoot: string
	keySource?: ReadableByteSource
	optionFiles: PickedFile[]
	appendLog: (message: string) => void
	setProgress: (progress: number) => void
	setRunStats: (updater: (current: RunStats) => RunStats) => void
}

export type ElapsedDetails = () => CompletedResult["details"]

/**
 * Extracts an already-open NTFS source into an Output Folder.
 *
 * @param context Shared extraction dependencies and progress callbacks.
 * @param ntfsSource Source produced from APP or VHD Chain resolution.
 * @param folderName Desired Output Folder name.
 * @param getExtraDetails Function that supplies elapsed/result details.
 * @param signal Abort signal for cancellation.
 * @param onBytesWritten Callback for progress accounting.
 * @returns Completed extraction result for history and UI display.
 */
async function extractNtfsSource(
	context: ExtractionServiceContext,
	ntfsSource: VhdNtfsSource,
	folderName: string,
	getExtraDetails: ElapsedDetails,
	signal: AbortSignal,
	onBytesWritten: (bytes: number) => void
): Promise<CompletedResult> {
	const { extractNtfsContents } = await import("../../../fsdecrypt/ntfs")
	const outputFolder = createOutputFolderPlan(context.outputRoot, folderName)
	await prepareOutputFolder(outputFolder)
	let totalBytes = 1
	const writer = createFolderWriter(outputFolder, () => totalBytes, context.setProgress, signal, onBytesWritten)
	const extracted = await extractNtfsContents(ntfsSource, writer, {
		onLog: context.appendLog,
		onTotalBytes: (bytes: number) => {
			totalBytes = bytes
			context.setRunStats(current => ({ ...current, totalBytes: bytes }))
		},
		signal
	})
	return {
		outputFolder: outputFolder.folderName,
		outputSegments: outputFolder.outputSegments,
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

/**
 * Runs a Base Extraction Job from one standalone APP.
 *
 * @param context Shared extraction dependencies and progress callbacks.
 * @param file Selected APP.
 * @param elapsedDetails Function that supplies elapsed/result details.
 * @param signal Abort signal for cancellation.
 * @param onBytesWritten Callback for progress accounting.
 * @returns Completed extraction result.
 */
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

/**
 * Runs a Merge Extraction Job from APPs and/or raw VHD Layers.
 *
 * @param context Shared extraction dependencies and progress callbacks.
 * @param group Selected Merge Selection Group.
 * @param elapsedDetails Function that supplies elapsed/result details.
 * @param signal Abort signal for cancellation.
 * @param onBytesWritten Callback for progress accounting.
 * @returns Completed extraction result.
 */
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
