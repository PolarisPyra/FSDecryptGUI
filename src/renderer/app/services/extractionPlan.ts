import type { ReadableByteSource } from "../../../fsdecrypt/byte-source"
import { stripExtension } from "../../base/common/path"
import type { CompletedResult, MergeSelectionGroup, RunStats, ToolMode } from "../common/appTypes"
import { runBaseExport, runMergeExport } from "./extractionService"
import { runOptionExport } from "./optionExtraction"
import type { RunScope, SelectionQueues } from "./selectionQueue"

// Planning is separated from execution so tests can verify which Extraction Jobs
// will run without touching Electron, filesystem writers, or fsdecrypt internals.
export type ExtractionProgressContext = {
	outputRoot: string
	keySource?: ReadableByteSource
	optionFiles: SelectedExtractionInputs["optionFiles"]
	appendLog: (message: string) => void
	setProgress: (progress: number) => void
	setRunStats: (updater: (current: RunStats) => RunStats) => void
}

export type ExtractionJob = {
	mode: ToolMode
	label: string
	sources: string[]
	run: () => Promise<CompletedResult>
}

export type SelectedExtractionInputs = {
	baseFiles: SelectionQueues["container"]["files"]
	optionFiles: SelectionQueues["option"]["files"]
	mergeGroups: MergeSelectionGroup[]
}

/**
 * Extracts selected Base files, OPTION files, and Merge groups from queues.
 *
 * @param queues Current Selection Queues.
 * @returns Selected inputs ready to become Extraction Jobs.
 */
export function selectExtractionInputs(queues: SelectionQueues): SelectedExtractionInputs {
	return {
		baseFiles: queues.container.groups.filter(group => group.selected).flatMap(group => group.files),
		optionFiles: queues.option.groups.filter(group => group.selected).flatMap(group => group.files),
		mergeGroups: queues.vhd.groups.filter(group => group.selected)
	}
}

/**
 * Chooses the Extraction Jobs for a requested run scope.
 *
 * @param runScope Active mode or all-mode scope.
 * @param jobs Jobs grouped by mode.
 * @returns Jobs in the order they should execute.
 */
export function scopeExtractionJobs(runScope: RunScope, jobs: Record<ToolMode, ExtractionJob[]>) {
	if (runScope === "all") {
		return [...jobs.container, ...jobs.option, ...jobs.vhd]
	}

	return jobs[runScope]
}

/**
 * Plans runnable Extraction Jobs without executing filesystem work.
 *
 * @param request Queue, scope, progress context, and abort state.
 * @returns Ordered jobs with labels, source names, and execution closures.
 */
export function createExtractionJobs(request: {
	queues: SelectionQueues
	runScope: RunScope
	context: ExtractionProgressContext
	elapsedDetails: () => CompletedResult["details"]
	signal: AbortSignal
	onBytesWritten: (bytes: number) => void
}) {
	const selected = selectExtractionInputs(request.queues)
	const baseJobs = selected.baseFiles.map(file => ({
		mode: "container" as ToolMode,
		label: stripExtension(file.name),
		sources: [file.name],
		run: () => runBaseExport(request.context, file, request.elapsedDetails, request.signal, request.onBytesWritten)
	}))
	const optionJobs = selected.optionFiles.map(file => ({
		mode: "option" as ToolMode,
		label: stripExtension(file.name),
		sources: [file.name],
		run: () => runOptionExport(request.context, file, request.elapsedDetails, request.signal, request.onBytesWritten)
	}))
	const mergeJobs = selected.mergeGroups.map(group => ({
		mode: "vhd" as ToolMode,
		label: group.label,
		sources: group.files.map(file => file.name),
		run: () => runMergeExport(request.context, group, request.elapsedDetails, request.signal, request.onBytesWritten)
	}))

	return scopeExtractionJobs(request.runScope, {
		container: baseJobs,
		option: optionJobs,
		vhd: mergeJobs
	})
}
