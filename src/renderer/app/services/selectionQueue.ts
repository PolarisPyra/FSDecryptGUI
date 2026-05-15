import type { ReadableByteSource } from "../../../fsdecrypt/byte-source"
import type { PickedFile, ScannedInputFolder } from "../../electron-api"
import { MODES } from "../common/modes"
import type { BaseSelectionGroup, MergeSelectionGroup, OptionSelectionGroup, ToolMode } from "../common/appTypes"
import { buildBaseGroups, buildMergeGroups, buildOptionGroups } from "./layerChainAnalysis"
import { validateKeyFile } from "./keySource"

export { validateKeyFile }

// Selection Queue mutation is centralized here so App.tsx does not need to know
// how Base, Option, and Merge store their analyzed Selection Groups.
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

/**
 * Preserves a user's include/exclude choices after expensive queue re-analysis.
 *
 * @param nextGroups Freshly analyzed Selection Groups.
 * @param previousGroups Prior groups with selected flags.
 * @returns Fresh groups with matching selected flags restored.
 */
function preserveGroupSelection<T extends { id: string; selected: boolean }>(nextGroups: T[], previousGroups: T[] = []) {
	const previousSelection = new Map(previousGroups.map(group => [group.id, group.selected]))
	return nextGroups.map(group => ({
		...group,
		selected: previousSelection.get(group.id) ?? true
	}))
}

/**
 * Appends picked files while deduplicating by path.
 *
 * @param current Existing Selection Queue files.
 * @param picked Newly picked files.
 * @returns A stable append-only list without duplicate paths.
 */
export function appendPickedFiles(current: PickedFile[], picked: PickedFile[]) {
	const merged = [...current]
	const seen = new Set(current.map(file => file.path))
	for (const file of picked) {
		if (seen.has(file.path)) continue
		seen.add(file.path)
		merged.push(file)
	}

	return merged
}

/**
 * Toggles one analyzed Selection Group in one mode.
 *
 * @param queues Current Selection Queues.
 * @param mode Mode whose group should change.
 * @param groupId Stable group identifier.
 * @param selected Whether the group should be included in extraction.
 * @returns Updated Selection Queues.
 */
export function selectSelectionGroup(queues: SelectionQueues, mode: ToolMode, groupId: string, selected: boolean): SelectionQueues {
	if (mode === "option") {
		return { ...queues, option: { ...queues.option, groups: queues.option.groups.map(group => (group.id === groupId ? { ...group, selected } : group)) } }
	}

	if (mode === "vhd") {
		return { ...queues, vhd: { ...queues.vhd, groups: queues.vhd.groups.map(group => (group.id === groupId ? { ...group, selected } : group)) } }
	}

	return { ...queues, container: { ...queues.container, groups: queues.container.groups.map(group => (group.id === groupId ? { ...group, selected } : group)) } }
}

/**
 * Toggles every Selection Group in a mode at once.
 *
 * @param queues Current Selection Queues.
 * @param mode Mode whose groups should change.
 * @param selected Whether every group should be included.
 * @returns Updated Selection Queues.
 */
export function selectModeSelectionGroups(queues: SelectionQueues, mode: ToolMode, selected: boolean): SelectionQueues {
	if (mode === "option") {
		return { ...queues, option: { ...queues.option, groups: queues.option.groups.map(group => ({ ...group, selected })) } }
	}

	if (mode === "vhd") {
		return { ...queues, vhd: { ...queues.vhd, groups: queues.vhd.groups.map(group => ({ ...group, selected })) } }
	}

	return { ...queues, container: { ...queues.container, groups: queues.container.groups.map(group => ({ ...group, selected })) } }
}

/**
 * Counts selected Extraction Jobs by mode.
 *
 * @param queues Current Selection Queues.
 * @returns Job counts keyed by mode.
 */
export function selectionJobCounts(queues: SelectionQueues): Record<ToolMode, number> {
	return {
		container: queues.container.groups.filter(group => group.selected).reduce((count, group) => count + group.files.length, 0),
		option: queues.option.groups.filter(group => group.selected).reduce((count, group) => count + group.files.length, 0),
		vhd: queues.vhd.groups.filter(group => group.selected).length
	}
}

/**
 * Reports whether each mode currently has a selected Blocking Warning.
 *
 * @param queues Current Selection Queues.
 * @returns Warning state keyed by mode.
 */
export function selectionWarningState(queues: SelectionQueues): Record<ToolMode, boolean> {
	return {
		container: queues.container.groups.some(group => group.selected && group.warning),
		option: queues.option.groups.some(group => group.selected && group.warning),
		vhd: queues.vhd.groups.some(group => group.selected && group.warning)
	}
}

/**
 * Computes the active run scope, job count, and Blocking Warning state.
 *
 * @param queues Current Selection Queues.
 * @param mode Active user-facing mode.
 * @param runAllModes Whether the all-mode toggle is enabled.
 * @returns Run readiness facts consumed by the app controller.
 */
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

/**
 * Converts a scanned input folder into Base, Option, and Merge Selection Queues.
 *
 * APPs with child layers or accompanying raw VHD Layers are routed to Merge,
 * while standalone APPs stay in Base.
 *
 * @param scan Classified files returned by the main process scanner.
 * @param keySource Optional Custom Key File source.
 * @param currentMode Current mode to preserve when no files are found.
 * @returns Next queues, preferred mode, all-mode toggle state, and log text.
 */
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
		container: { files: baseFiles, groups: preserveGroupSelection(baseGroups) },
		option: { files: scan.files.options, groups: preserveGroupSelection(optionGroups) },
		vhd: { files: mergeFiles, groups: preserveGroupSelection(mergeGroups) }
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

/**
 * Adds files to the current mode's Selection Queue and re-analyzes that mode.
 *
 * @param queues Current Selection Queues.
 * @param mode Target mode.
 * @param files Newly picked files.
 * @param keySource Optional Custom Key File source.
 * @returns Updated queues with prior group selections preserved.
 */
export async function appendToSelectionQueue(
	queues: SelectionQueues,
	mode: ToolMode,
	files: PickedFile[],
	keySource: ReadableByteSource | undefined
): Promise<SelectionQueues> {
	if (mode === "option") {
		const optionFiles = appendPickedFiles(queues.option.files, files)
		const optionGroups = await buildOptionGroups(optionFiles, keySource)
		return {
			...queues,
			option: { files: optionFiles, groups: preserveGroupSelection(optionGroups, queues.option.groups) }
		}
	}

	if (mode === "vhd") {
		const mergeFiles = appendPickedFiles(queues.vhd.files, files)
		const mergeGroups = await buildMergeGroups(mergeFiles, keySource)
		return {
			...queues,
			vhd: { files: mergeFiles, groups: preserveGroupSelection(mergeGroups, queues.vhd.groups) }
		}
	}

	const baseFiles = appendPickedFiles(queues.container.files, files)
	const baseGroups = await buildBaseGroups(baseFiles, keySource)
	return {
		...queues,
		container: { files: baseFiles, groups: preserveGroupSelection(baseGroups, queues.container.groups) }
	}
}

/**
 * Removes one file from a mode's Selection Queue and re-analyzes that mode.
 *
 * @param queues Current Selection Queues.
 * @param mode Target mode.
 * @param path File path to remove.
 * @param keySource Optional Custom Key File source.
 * @returns Updated queues with prior group selections preserved where possible.
 */
export async function removeFromSelectionQueue(
	queues: SelectionQueues,
	mode: ToolMode,
	path: string,
	keySource: ReadableByteSource | undefined
): Promise<SelectionQueues> {
	if (mode === "option") {
		const optionFiles = queues.option.files.filter(file => file.path !== path)
		const optionGroups = optionFiles.length > 0 ? await buildOptionGroups(optionFiles, keySource) : []
		return {
			...queues,
			option: { files: optionFiles, groups: preserveGroupSelection(optionGroups, queues.option.groups) }
		}
	}

	if (mode === "vhd") {
		const mergeFiles = queues.vhd.files.filter(file => file.path !== path)
		const mergeGroups = mergeFiles.length > 0 ? await buildMergeGroups(mergeFiles, keySource) : []
		return {
			...queues,
			vhd: { files: mergeFiles, groups: preserveGroupSelection(mergeGroups, queues.vhd.groups) }
		}
	}

	const baseFiles = queues.container.files.filter(file => file.path !== path)
	const baseGroups = baseFiles.length > 0 ? await buildBaseGroups(baseFiles, keySource) : []
	return {
		...queues,
		container: { files: baseFiles, groups: preserveGroupSelection(baseGroups, queues.container.groups) }
	}
}

/**
 * Rebuilds all analyzed Selection Groups after Key Source changes.
 *
 * @param queues Current Selection Queues.
 * @param keySource Optional Custom Key File source.
 * @returns Updated queues with previous group selections preserved.
 */
export async function refreshSelectionQueues(queues: SelectionQueues, keySource: ReadableByteSource | undefined): Promise<SelectionQueues> {
	const [baseGroups, optionGroups, mergeGroups] = await Promise.all([
		queues.container.files.length > 0 ? buildBaseGroups(queues.container.files, keySource) : Promise.resolve([]),
		queues.option.files.length > 0 ? buildOptionGroups(queues.option.files, keySource) : Promise.resolve([]),
		queues.vhd.files.length > 0 ? buildMergeGroups(queues.vhd.files, keySource) : Promise.resolve([])
	])

	return {
		container: { files: queues.container.files, groups: preserveGroupSelection(baseGroups, queues.container.groups) },
		option: { files: queues.option.files, groups: preserveGroupSelection(optionGroups, queues.option.groups) },
		vhd: { files: queues.vhd.files, groups: preserveGroupSelection(mergeGroups, queues.vhd.groups) }
	}
}

/**
 * Moves a Base Selection Group into Merge so parent-child APP Chains extract correctly.
 *
 * @param queues Current Selection Queues.
 * @param group Base group to move.
 * @param keySource Optional Custom Key File source.
 * @returns Queues with the group removed from Base and appended to Merge.
 */
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
		container: { files: baseFiles, groups: preserveGroupSelection(baseGroups, queues.container.groups) },
		vhd: { files: mergeFiles, groups: preserveGroupSelection(mergeGroups, queues.vhd.groups) }
	}
}
