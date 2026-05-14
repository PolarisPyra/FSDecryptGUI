import type { ReadableByteSource } from "../../../fsdecrypt/byte-source"
import type { PickedFile, ScannedInputFolder } from "../../electron-api"
import { MODES } from "../common/modes"
import type { BaseSelectionGroup, MergeSelectionGroup, OptionSelectionGroup, ToolMode } from "../common/appTypes"
import { appendPickedFiles, buildBaseGroups, buildMergeGroups, buildOptionGroups, validateKeyFile } from "./selectionService"

export { validateKeyFile }

export type RunScope = "all" | ToolMode

export type SelectionQueues = {
	container: {
		files: PickedFile[]
		groups: BaseSelectionGroup[]
	}
	option: {
		files: PickedFile[]
		groups: OptionSelectionGroup[]
	}
	vhd: {
		files: PickedFile[]
		groups: MergeSelectionGroup[]
	}
}

export function emptySelectionQueues(): SelectionQueues {
	return {
		container: { files: [], groups: [] },
		option: { files: [], groups: [] },
		vhd: { files: [], groups: [] }
	}
}

export function selectionJobCounts(queues: SelectionQueues): Record<ToolMode, number> {
	return {
		container: queues.container.files.length,
		option: queues.option.files.length,
		vhd: queues.vhd.groups.length
	}
}

export function selectionWarningState(queues: SelectionQueues): Record<ToolMode, boolean> {
	return {
		container: queues.container.groups.some(group => group.warning),
		option: queues.option.groups.some(group => group.warning),
		vhd: queues.vhd.groups.some(group => group.warning)
	}
}

export function selectionSummary(queues: SelectionQueues, mode: ToolMode, runAllModes: boolean) {
	const jobCounts = selectionJobCounts(queues)
	const warningState = selectionWarningState(queues)
	const modeScopesWithJobs = MODES.map(item => item.mode).filter(item => jobCounts[item] > 0)
	const hasMultipleModeJobs = modeScopesWithJobs.length > 1
	const effectiveRunScope: RunScope = runAllModes && hasMultipleModeJobs ? "all" : mode
	const allJobCount = jobCounts.container + jobCounts.option + jobCounts.vhd
	const effectiveJobCount = effectiveRunScope === "all" ? allJobCount : jobCounts[effectiveRunScope]
	const allWarnings = Object.values(warningState).some(Boolean)

	return {
		jobCounts,
		warningState,
		hasMultipleModeJobs,
		effectiveRunScope,
		effectiveJobCount,
		hasBlockingWarnings: effectiveRunScope === "all" ? allWarnings : warningState[effectiveRunScope]
	}
}

export async function analyzeInputScan(
	scan: ScannedInputFolder,
	keySource: ReadableByteSource | undefined,
	currentMode: ToolMode
) {
	const scannedAppGroups = await buildBaseGroups(scan.files.apps, keySource)
	const basePaths = new Set<string>()
	const mergePaths = new Set(scan.files.vhds.map(file => file.path))
	for (const group of scannedAppGroups) {
		const target = group.hasChildLayer || group.rawVhds.length > 0 ? mergePaths : basePaths
		for (const file of group.files) {
			target.add(file.path)
		}
	}

	const allAppFilesByPath = new Map(scan.files.apps.map(file => [file.path, file]))
	const baseFiles = [...basePaths].map(path => allAppFilesByPath.get(path)).filter((file): file is PickedFile => Boolean(file))
	const mergeFiles = [...scan.files.apps.filter(file => mergePaths.has(file.path)), ...scan.files.vhds]
	const [baseGroups, optionGroups, mergeGroups] = await Promise.all([
		buildBaseGroups(baseFiles, keySource),
		buildOptionGroups(scan.files.options, keySource),
		buildMergeGroups(mergeFiles, keySource)
	])
	const queues: SelectionQueues = {
		container: { files: baseFiles, groups: baseGroups },
		option: { files: scan.files.options, groups: optionGroups },
		vhd: { files: mergeFiles, groups: mergeGroups }
	}
	const detectedModes = [baseFiles.length > 0, scan.files.options.length > 0, mergeGroups.length > 0].filter(Boolean).length
	const nextMode: ToolMode = baseFiles.length > 0 ? "container" : scan.files.options.length > 0 ? "option" : mergeGroups.length > 0 ? "vhd" : currentMode

	return {
		queues,
		nextMode,
		runAllModes: detectedModes > 1,
		logMessage: `Input folder scanned: ${baseFiles.length.toLocaleString()} base APP(s), ${scan.files.options.length.toLocaleString()} OPTION(s), ${mergeFiles.length.toLocaleString()} merge file(s)`
	}
}

export async function appendToSelectionQueue(
	queues: SelectionQueues,
	mode: ToolMode,
	files: PickedFile[],
	keySource: ReadableByteSource | undefined
): Promise<SelectionQueues> {
	if (mode === "option") {
		const optionFiles = appendPickedFiles(queues.option.files, files)
		return {
			...queues,
			option: { files: optionFiles, groups: await buildOptionGroups(optionFiles, keySource) }
		}
	}

	if (mode === "vhd") {
		const mergeFiles = appendPickedFiles(queues.vhd.files, files)
		return {
			...queues,
			vhd: { files: mergeFiles, groups: await buildMergeGroups(mergeFiles, keySource) }
		}
	}

	const baseFiles = appendPickedFiles(queues.container.files, files)
	return {
		...queues,
		container: { files: baseFiles, groups: await buildBaseGroups(baseFiles, keySource) }
	}
}

export async function removeFromSelectionQueue(
	queues: SelectionQueues,
	mode: ToolMode,
	path: string,
	keySource: ReadableByteSource | undefined
): Promise<SelectionQueues> {
	if (mode === "option") {
		const optionFiles = queues.option.files.filter(file => file.path !== path)
		return {
			...queues,
			option: { files: optionFiles, groups: optionFiles.length > 0 ? await buildOptionGroups(optionFiles, keySource) : [] }
		}
	}

	if (mode === "vhd") {
		const mergeFiles = queues.vhd.files.filter(file => file.path !== path)
		return {
			...queues,
			vhd: { files: mergeFiles, groups: mergeFiles.length > 0 ? await buildMergeGroups(mergeFiles, keySource) : [] }
		}
	}

	const baseFiles = queues.container.files.filter(file => file.path !== path)
	return {
		...queues,
		container: { files: baseFiles, groups: baseFiles.length > 0 ? await buildBaseGroups(baseFiles, keySource) : [] }
	}
}

export async function refreshSelectionQueues(queues: SelectionQueues, keySource: ReadableByteSource | undefined): Promise<SelectionQueues> {
	const [baseGroups, optionGroups, mergeGroups] = await Promise.all([
		queues.container.files.length > 0 ? buildBaseGroups(queues.container.files, keySource) : Promise.resolve([]),
		queues.option.files.length > 0 ? buildOptionGroups(queues.option.files, keySource) : Promise.resolve([]),
		queues.vhd.files.length > 0 ? buildMergeGroups(queues.vhd.files, keySource) : Promise.resolve([])
	])

	return {
		container: { files: queues.container.files, groups: baseGroups },
		option: { files: queues.option.files, groups: optionGroups },
		vhd: { files: queues.vhd.files, groups: mergeGroups }
	}
}

export async function moveBaseGroupToMergeQueue(
	queues: SelectionQueues,
	group: BaseSelectionGroup,
	keySource: ReadableByteSource | undefined
): Promise<SelectionQueues> {
	const movingPaths = new Set(group.files.map(file => file.path))
	const baseFiles = queues.container.files.filter(file => !movingPaths.has(file.path))
	const mergeFiles = appendPickedFiles(queues.vhd.files, group.files)
	const [baseGroups, mergeGroups] = await Promise.all([
		baseFiles.length > 0 ? buildBaseGroups(baseFiles, keySource) : Promise.resolve([]),
		buildMergeGroups(mergeFiles, keySource)
	])

	return {
		...queues,
		container: { files: baseFiles, groups: baseGroups },
		vhd: { files: mergeFiles, groups: mergeGroups }
	}
}
