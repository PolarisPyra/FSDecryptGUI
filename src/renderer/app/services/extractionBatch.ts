import type { ReadableByteSource } from "../../../fsdecrypt/byte-source"
import { isAbortError } from "../../base/common/cancellation"
import { formatDuration } from "../../base/common/format"
import { stripExtension } from "../../base/common/path"
import type { ActiveJob, CompletedResult, ExportHistoryItem, RunStats, ToolMode } from "../common/appTypes"
import type { RunScope, SelectionQueues } from "./selectionQueue"
import { runBaseExport, runMergeExport } from "./extractionService"
import { runOptionExport } from "./optionExtraction"

type HistoryInput = Omit<ExportHistoryItem, "id" | "completedAt">

export type ExtractionBatchRequest = {
	queues: SelectionQueues
	runScope: RunScope
	scopeLabel: string
	outputRoot: string
	keySource?: ReadableByteSource
	signal: AbortSignal
	startedAt: number
	appendLog: (message: string) => void
	addHistory: (item: HistoryInput) => void
	notifyUser: (title: string, body: string) => Promise<void>
	setActiveJob: (job: ActiveJob | null) => void
	setProgress: (progress: number) => void
	setResult: (result: CompletedResult | null) => void
	setRunStats: (updater: (current: RunStats) => RunStats) => void
}

export async function runExtractionBatch(request: ExtractionBatchRequest) {
	const elapsedDetails = (): CompletedResult["details"] => {
		const value = formatDuration(performance.now() - request.startedAt)
		return [{ label: "Elapsed", value }]
	}
	const noteBytesWritten = (bytes: number) => {
		request.setRunStats(current => ({
			...current,
			bytesWritten: current.bytesWritten + bytes,
			elapsedMs: performance.now() - request.startedAt
		}))
	}
	const extractionContext = {
		outputRoot: request.outputRoot,
		keySource: request.keySource,
		optionFiles: request.queues.option.files,
		appendLog: request.appendLog,
		setProgress: request.setProgress,
		setRunStats: request.setRunStats
	}
	const baseJobs = request.queues.container.files.map(file => ({
		mode: "container" as ToolMode,
		label: stripExtension(file.name),
		sources: [file.name],
		run: () => runBaseExport(extractionContext, file, elapsedDetails, request.signal, noteBytesWritten)
	}))
	const optionJobs = request.queues.option.files.map(file => ({
		mode: "option" as ToolMode,
		label: stripExtension(file.name),
		sources: [file.name],
		run: () => runOptionExport(extractionContext, file, elapsedDetails, request.signal, noteBytesWritten)
	}))
	const mergeJobs = request.queues.vhd.groups.map(group => ({
		mode: "vhd" as ToolMode,
		label: group.label,
		sources: group.files.map(file => file.name),
		run: () => runMergeExport(extractionContext, group, elapsedDetails, request.signal, noteBytesWritten)
	}))
	const jobs =
		request.runScope === "all"
			? [...baseJobs, ...optionJobs, ...mergeJobs]
			: request.runScope === "vhd"
				? mergeJobs
				: request.runScope === "option"
					? optionJobs
					: baseJobs

	try {
		request.appendLog(`Starting ${request.scopeLabel} batch with ${jobs.length.toLocaleString()} export(s)`)
		let successfulJobs = 0
		let failedJobs = 0

		for (let index = 0; index < jobs.length; index++) {
			const job = jobs[index]
			const jobStartedAt = performance.now()
			request.setProgress(0)
			request.setActiveJob({ index: index + 1, total: jobs.length, label: job.label })
			request.appendLog(`[${index + 1}/${jobs.length}] Exporting ${job.label}`)

			try {
				const nextResult = await job.run()
				request.setResult(nextResult)
				request.setProgress(100)
				request.addHistory({
					status: "success",
					mode: job.mode,
					label: job.label,
					sources: job.sources,
					outputFolder: nextResult.outputFolder,
					outputSegments: nextResult.outputSegments,
					outputRoot: nextResult.outputRoot,
					outputSize: nextResult.outputSize,
					durationMs: performance.now() - jobStartedAt
				})
				successfulJobs += 1
			} catch (error) {
				if (isAbortError(error)) {
					request.addHistory({
						status: "cancelled",
						mode: job.mode,
						label: job.label,
						sources: job.sources,
						durationMs: performance.now() - jobStartedAt,
						error: "Cancelled"
					})
					throw error
				}

				const message = error instanceof Error ? error.message : "fsdecrypt failed"
				request.appendLog(`ERROR: ${job.label}: ${message}`)
				failedJobs += 1
				request.addHistory({
					status: "failed",
					mode: job.mode,
					label: job.label,
					sources: job.sources,
					durationMs: performance.now() - jobStartedAt,
					error: message
				})
			}
		}

		request.appendLog("Done")
		if (failedJobs > 0) {
			await request.notifyUser("fsdecryptGUI finished with errors", `${successfulJobs}/${jobs.length} export(s) completed. ${failedJobs} failed.`)
		} else {
			await request.notifyUser("fsdecryptGUI extraction complete", `${successfulJobs}/${jobs.length} export(s) completed.`)
		}
	} catch (error) {
		console.error(error)
		if (isAbortError(error)) {
			request.setProgress(0)
			request.appendLog("Cancelled")
			await request.notifyUser("fsdecryptGUI extraction cancelled", "The current extraction was cancelled.")
			return
		}

		request.appendLog(error instanceof Error ? `ERROR: ${error.message}` : "ERROR: fsdecrypt failed")
		await request.notifyUser("fsdecryptGUI extraction failed", error instanceof Error ? error.message : "fsdecrypt failed")
	}
}
