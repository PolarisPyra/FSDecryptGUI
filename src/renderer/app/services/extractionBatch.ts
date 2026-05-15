import type { ReadableByteSource } from "../../../fsdecrypt/byte-source"
import { isAbortError } from "../../base/common/cancellation"
import { formatDuration } from "../../base/common/format"
import type { ActiveJob, CompletedResult, ExportHistoryItem, RunStats } from "../common/appTypes"
import { createExtractionJobs } from "./extractionPlan"
import type { RunScope, SelectionQueues } from "./selectionQueue"

type HistoryInput = Omit<ExportHistoryItem, "id" | "completedAt">

export type ExtractionBatchEvents = {
	appendLog: (message: string) => void
	addHistory: (item: HistoryInput) => void
	notifyUser: (title: string, body: string) => Promise<void>
	setActiveJob: (job: ActiveJob | null) => void
	setProgress: (progress: number) => void
	setResult: (result: CompletedResult | null) => void
	setRunStats: (updater: (current: RunStats) => RunStats) => void
}

export type ExtractionBatchRequest = {
	queues: SelectionQueues
	runScope: RunScope
	scopeLabel: string
	outputRoot: string
	keySource?: ReadableByteSource
	signal: AbortSignal
	startedAt: number
	events: ExtractionBatchEvents
}

/**
 * Executes an Extraction Batch and emits UI events for progress/history/results.
 *
 * @param request Queue state, run scope, output folder, key source, abort signal, and event sink.
 */
export async function runExtractionBatch(request: ExtractionBatchRequest) {
	const events = request.events
	const elapsedDetails = (): CompletedResult["details"] => {
		const value = formatDuration(performance.now() - request.startedAt)
		return [{ label: "Elapsed", value }]
	}
	const noteBytesWritten = (bytes: number) => {
		events.setRunStats(current => ({
			...current,
			bytesWritten: current.bytesWritten + bytes,
			elapsedMs: performance.now() - request.startedAt
		}))
	}
	const extractionContext = {
		outputRoot: request.outputRoot,
		keySource: request.keySource,
		optionFiles: request.queues.option.groups.filter(group => group.selected).flatMap(group => group.files),
		appendLog: events.appendLog,
		setProgress: events.setProgress,
		setRunStats: events.setRunStats
	}
	const jobs = createExtractionJobs({
		queues: request.queues,
		runScope: request.runScope,
		context: extractionContext,
		elapsedDetails,
		signal: request.signal,
		onBytesWritten: noteBytesWritten
	})

	try {
		events.appendLog(`Starting ${request.scopeLabel} batch with ${jobs.length.toLocaleString()} export(s)`)
		let successfulJobs = 0
		let failedJobs = 0

		for (let index = 0; index < jobs.length; index++) {
			const job = jobs[index]
			const jobStartedAt = performance.now()
			events.setProgress(0)
			events.setActiveJob({ index: index + 1, total: jobs.length, label: job.label })
			events.appendLog(`[${index + 1}/${jobs.length}] Exporting ${job.label}`)

			try {
				const nextResult = await job.run()
				events.setResult(nextResult)
				events.setProgress(100)
				events.addHistory({
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
					events.addHistory({
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
				events.appendLog(`ERROR: ${job.label}: ${message}`)
				failedJobs += 1
				events.addHistory({
					status: "failed",
					mode: job.mode,
					label: job.label,
					sources: job.sources,
					durationMs: performance.now() - jobStartedAt,
					error: message
				})
			}
		}

		events.appendLog("Done")
		if (failedJobs > 0) {
			await events.notifyUser("fsdecryptGUI finished with errors", `${successfulJobs}/${jobs.length} export(s) completed. ${failedJobs} failed.`)
		} else {
			await events.notifyUser("fsdecryptGUI extraction complete", `${successfulJobs}/${jobs.length} export(s) completed.`)
		}
	} catch (error) {
		console.error(error)
		if (isAbortError(error)) {
			events.setProgress(0)
			events.appendLog("Cancelled")
			await events.notifyUser("fsdecryptGUI extraction cancelled", "The current extraction was cancelled.")
			return
		}

		events.appendLog(error instanceof Error ? `ERROR: ${error.message}` : "ERROR: fsdecrypt failed")
		await events.notifyUser("fsdecryptGUI extraction failed", error instanceof Error ? error.message : "fsdecrypt failed")
	}
}
