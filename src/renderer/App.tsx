import { useEffect, useMemo, useRef, useState } from "react"

import type { ReadableByteSource } from "../fsdecrypt/byte-source"
import { isAbortError } from "./base/common/cancellation"
import { formatDuration, formatLogExport, logExportName } from "./base/common/format"
import { dirname, pathInFolder, stripExtension } from "./base/common/path"
import { PickedFile, RendererConfig, byteSourceFromPickedFile } from "./electron-api"
import { AppView } from "./app/browser/appView"
import { MODES } from "./app/common/modes"
import type {
	BaseSelectionGroup,
	CompletedResult,
	ExportHistoryItem,
	MergeSelectionGroup,
	OptionSelectionGroup,
	RunStats,
	ToolMode
} from "./app/common/appTypes"
import { runBaseExport, runMergeExport, runOptionExport } from "./app/services/extractionService"
import { historyId, readStoredHistory, writeStoredHistory } from "./app/services/historyStorage"
import {
	appendPickedFiles,
	buildBaseGroups,
	buildMergeGroups,
	buildOptionGroups,
	validateKeyFile
} from "./app/services/selectionService"

export function App() {
	const [mode, setMode] = useState<ToolMode>("container")
	const [baseFiles, setBaseFiles] = useState<PickedFile[]>([])
	const [baseGroups, setBaseGroups] = useState<BaseSelectionGroup[]>([])
	const [isAnalyzingBase, setIsAnalyzingBase] = useState(false)
	const [optionFiles, setOptionFiles] = useState<PickedFile[]>([])
	const [optionGroups, setOptionGroups] = useState<OptionSelectionGroup[]>([])
	const [isAnalyzingOptions, setIsAnalyzingOptions] = useState(false)
	const [keyFile, setKeyFile] = useState<PickedFile | null>(null)
	const [mergeFiles, setMergeFiles] = useState<PickedFile[]>([])
	const [mergeGroups, setMergeGroups] = useState<MergeSelectionGroup[]>([])
	const [isAnalyzingMerge, setIsAnalyzingMerge] = useState(false)
	const [outputRoot, setOutputRoot] = useState("")
	const [configPath, setConfigPath] = useState("")
	const [isBusy, setIsBusy] = useState(false)
	const [progress, setProgress] = useState(0)
	const [runStats, setRunStats] = useState<RunStats>({ elapsedMs: 0, bytesWritten: 0, totalBytes: 0 })
	const [logs, setLogs] = useState<string[]>(["Ready"])
	const [result, setResult] = useState<CompletedResult | null>(null)
	const [activeJob, setActiveJob] = useState<{ index: number; total: number; label: string } | null>(null)
	const [history, setHistory] = useState<ExportHistoryItem[]>(readStoredHistory)
	const terminalRef = useRef<HTMLDivElement>(null)
	const abortControllerRef = useRef<AbortController | null>(null)
	const runStartedAtRef = useRef(0)

	useEffect(() => {
		terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight })
	}, [logs])

	useEffect(() => {
		writeStoredHistory(history)
	}, [history])

	useEffect(() => {
		if (!isBusy) return

		const interval = window.setInterval(() => {
			setRunStats(current => ({ ...current, elapsedMs: performance.now() - runStartedAtRef.current }))
		}, 250)

		return () => window.clearInterval(interval)
	}, [isBusy])

	const selectedContainerFiles = mode === "option" ? optionFiles : baseFiles
	const selectedJobCount = mode === "vhd" ? mergeGroups.length : selectedContainerFiles.length
	const selectedWarnings =
		mode === "vhd"
			? mergeGroups.some(group => group.warning)
			: mode === "option"
				? optionGroups.some(group => group.warning)
				: baseGroups.some(group => group.warning)
	const keyValidation = useMemo(() => validateKeyFile(keyFile), [keyFile])
	const canRun =
		!isBusy &&
		Boolean(outputRoot) &&
		selectedJobCount > 0 &&
		!selectedWarnings &&
		keyValidation.status !== "invalid" &&
		!isAnalyzingMerge &&
		!isAnalyzingOptions &&
		!isAnalyzingBase
	const modeLabel = MODES.find(item => item.mode === mode)!.label.toUpperCase()
	const keySource = useMemo(() => (keyFile ? byteSourceFromPickedFile(keyFile) : undefined), [keyFile])
	const configFolder = useMemo(() => dirname(configPath), [configPath])

	const appendLog = (message: string) => {
		const timestamp = new Date().toLocaleTimeString()
		setLogs(current => [...current.slice(-260), `[${timestamp}] ${message}`])
	}

	const addHistory = (item: Omit<ExportHistoryItem, "id" | "completedAt">) => {
		setHistory(current => [
			{
				...item,
				id: historyId(),
				completedAt: new Date().toISOString()
			},
			...current
		].slice(0, 50))
	}

	const clearHistory = () => {
		setHistory([])
	}

	const copyLogs = async () => {
		try {
			await window.fsdecryptGUI.copyText(formatLogExport(logs))
			appendLog("Copied log to clipboard")
		} catch (error) {
			appendLog(error instanceof Error ? `Could not copy log: ${error.message}` : "Could not copy log")
		}
	}

	const saveLogs = async () => {
		try {
			const savedPath = await window.fsdecryptGUI.saveText({
				defaultName: pathInFolder(outputRoot, logExportName()),
				content: formatLogExport(logs)
			})
			if (savedPath) {
				appendLog(`Saved log to ${savedPath}`)
			}
		} catch (error) {
			appendLog(error instanceof Error ? `Could not save log: ${error.message}` : "Could not save log")
		}
	}

	const notifyUser = async (title: string, body: string) => {
		try {
			await window.fsdecryptGUI.notify({ title, body })
		} catch (error) {
			appendLog(error instanceof Error ? `Could not send notification: ${error.message}` : "Could not send notification")
		}
	}

	useEffect(() => {
		const applyConfig = (config: RendererConfig) => {
			setOutputRoot(config.outputRoot ?? "")
			setKeyFile(config.keyFile ?? null)
			setConfigPath(config.configPath)
		}

		window.fsdecryptGUI
			.readConfig()
			.then(applyConfig)
			.catch(error => {
				appendLog(error instanceof Error ? `Could not read config: ${error.message}` : "Could not read config")
			})

		return window.fsdecryptGUI.onConfigChanged(config => {
			applyConfig(config)
			appendLog(config.outputRoot ? `Output root selected: ${config.outputRoot}` : "Output root cleared")
		})
	}, [])

	const chooseContainer = async () => {
		const isOption = mode === "option"
		const files = await window.fsdecryptGUI.pickFiles({
			title: isOption ? "Choose updates" : "Choose games",
			multiple: true,
			filters: [
				isOption
					? { name: "Option containers", extensions: ["opt"] }
					: { name: "APP containers", extensions: ["app"] },
				{ name: "All files", extensions: ["*"] }
			]
		})
		if (files.length === 0) return

		if (isOption) {
			const nextFiles = appendPickedFiles(optionFiles, files)
			setOptionFiles(nextFiles)
			setOptionGroups([])
			setIsAnalyzingOptions(true)
			try {
				setOptionGroups(await buildOptionGroups(nextFiles, keySource))
			} catch (error) {
				appendLog(error instanceof Error ? `Could not analyze OPTION VHD selection: ${error.message}` : "Could not analyze OPTION VHD selection")
			} finally {
				setIsAnalyzingOptions(false)
			}
		} else {
			const nextFiles = appendPickedFiles(baseFiles, files)
			setBaseFiles(nextFiles)
			setBaseGroups([])
			setIsAnalyzingBase(true)
			try {
				setBaseGroups(await buildBaseGroups(nextFiles, keySource))
			} catch (error) {
				appendLog(error instanceof Error ? `Could not analyze APP selection: ${error.message}` : "Could not analyze APP selection")
			} finally {
				setIsAnalyzingBase(false)
			}
		}
		setResult(null)
	}

	const refreshSelectionsForKey = async (nextKeySource: ReadableByteSource | undefined) => {
		if (baseFiles.length > 0) {
			setIsAnalyzingBase(true)
			try {
				setBaseGroups(await buildBaseGroups(baseFiles, nextKeySource))
			} catch (error) {
				appendLog(error instanceof Error ? `Could not refresh APP selection: ${error.message}` : "Could not refresh APP selection")
			} finally {
				setIsAnalyzingBase(false)
			}
		}
		if (optionFiles.length > 0) {
			setIsAnalyzingOptions(true)
			try {
				setOptionGroups(await buildOptionGroups(optionFiles, nextKeySource))
			} catch (error) {
				appendLog(error instanceof Error ? `Could not refresh OPTION VHD selection: ${error.message}` : "Could not refresh OPTION VHD selection")
			} finally {
				setIsAnalyzingOptions(false)
			}
		}
		if (mergeFiles.length > 0) {
			setIsAnalyzingMerge(true)
			try {
				setMergeGroups(await buildMergeGroups(mergeFiles, nextKeySource))
			} catch (error) {
				appendLog(error instanceof Error ? `Could not refresh merge selection: ${error.message}` : "Could not refresh merge selection")
			} finally {
				setIsAnalyzingMerge(false)
			}
		}
	}

	const chooseKey = async () => {
		const files = await window.fsdecryptGUI.pickFiles({
			title: "Choose key file",
			filters: [
				{ name: "Key files", extensions: ["bin"] },
				{ name: "All files", extensions: ["*"] }
			]
		})
		if (!files[0]) return
		const nextKeyFile = files[0]
		const validation = validateKeyFile(nextKeyFile)
		if (validation.status === "invalid") {
			appendLog(`Invalid key file ${nextKeyFile.name}: ${validation.error}`)
			return
		}

		try {
			setKeyFile(nextKeyFile)
			await window.fsdecryptGUI.updateConfig({ keyFilePath: nextKeyFile.path })
			appendLog(`Custom key selected: ${nextKeyFile.name} (${nextKeyFile.size} bytes)`)
			await refreshSelectionsForKey(byteSourceFromPickedFile(nextKeyFile))
			setResult(null)
		} catch (error) {
			appendLog(error instanceof Error ? `Could not select key: ${error.message}` : "Could not select key")
		}
	}

	const clearKey = async () => {
		if (isBusy) return

		try {
			setKeyFile(null)
			await window.fsdecryptGUI.updateConfig({ keyFilePath: null })
			appendLog("Custom key cleared; using built-in keys")
			await refreshSelectionsForKey(undefined)
			setResult(null)
		} catch (error) {
			appendLog(error instanceof Error ? `Could not clear key: ${error.message}` : "Could not clear key")
		}
	}

	const chooseApps = async () => {
		const files = await window.fsdecryptGUI.pickFiles({
			title: "Choose APP or VHD chain layers",
			multiple: true,
			filters: [
				{ name: "APP and VHD files", extensions: ["app", "vhd"] },
				{ name: "All files", extensions: ["*"] }
			]
		})
		if (files.length === 0) return

		const nextFiles = appendPickedFiles(mergeFiles, files)
		setMergeFiles(nextFiles)
		setMergeGroups([])
		setResult(null)

		setIsAnalyzingMerge(true)
		try {
			setMergeGroups(await buildMergeGroups(nextFiles, keySource))
		} catch (error) {
			appendLog(error instanceof Error ? `Could not analyze merge selection: ${error.message}` : "Could not analyze merge selection")
		} finally {
			setIsAnalyzingMerge(false)
		}
	}

	const removeBaseFile = async (path: string) => {
		if (isBusy) return

		const nextFiles = baseFiles.filter(file => file.path !== path)
		setBaseFiles(nextFiles)
		setBaseGroups([])
		setResult(null)
		if (nextFiles.length === 0) return

		setIsAnalyzingBase(true)
		try {
			setBaseGroups(await buildBaseGroups(nextFiles, keySource))
		} catch (error) {
			appendLog(error instanceof Error ? `Could not analyze APP selection: ${error.message}` : "Could not analyze APP selection")
		} finally {
			setIsAnalyzingBase(false)
		}
	}

	const removeOptionFile = async (path: string) => {
		if (isBusy) return

		const nextFiles = optionFiles.filter(file => file.path !== path)
		setOptionFiles(nextFiles)
		setOptionGroups([])
		setResult(null)
		if (nextFiles.length === 0) return

		setIsAnalyzingOptions(true)
		try {
			setOptionGroups(await buildOptionGroups(nextFiles, keySource))
		} catch (error) {
			appendLog(error instanceof Error ? `Could not analyze OPTION VHD selection: ${error.message}` : "Could not analyze OPTION VHD selection")
		} finally {
			setIsAnalyzingOptions(false)
		}
	}

	const removeMergeFile = async (path: string) => {
		if (isBusy) return

		const nextFiles = mergeFiles.filter(file => file.path !== path)
		setMergeFiles(nextFiles)
		setMergeGroups([])
		setResult(null)
		if (nextFiles.length === 0) return

		setIsAnalyzingMerge(true)
		try {
			setMergeGroups(await buildMergeGroups(nextFiles, keySource))
		} catch (error) {
			appendLog(error instanceof Error ? `Could not analyze merge selection: ${error.message}` : "Could not analyze merge selection")
		} finally {
			setIsAnalyzingMerge(false)
		}
	}

	const reset = () => {
		setBaseFiles([])
		setBaseGroups([])
		setIsAnalyzingBase(false)
		setOptionFiles([])
		setOptionGroups([])
		setIsAnalyzingOptions(false)
		setMergeFiles([])
		setMergeGroups([])
		setIsAnalyzingMerge(false)
		setProgress(0)
		setRunStats({ elapsedMs: 0, bytesWritten: 0, totalBytes: 0 })
		setActiveJob(null)
		setLogs(["Ready"])
		setResult(null)
	}

	const cancelRun = () => {
		abortControllerRef.current?.abort()
		appendLog("Cancelling extraction...")
	}

	const openConfigFolder = async () => {
		try {
			await window.fsdecryptGUI.openConfigFolder()
		} catch (error) {
			appendLog(error instanceof Error ? `Could not open config folder: ${error.message}` : "Could not open config folder")
		}
	}

	const selectOutputFolder = async () => {
		try {
			await window.fsdecryptGUI.selectOutputFolder()
		} catch (error) {
			appendLog(error instanceof Error ? `Could not select output folder: ${error.message}` : "Could not select output folder")
		}
	}

	const openOutputRootFolder = async () => {
		if (!outputRoot) return

		try {
			await window.fsdecryptGUI.openOutputFolder(outputRoot, [])
		} catch (error) {
			appendLog(error instanceof Error ? `Could not open output folder: ${error.message}` : "Could not open output folder")
		}
	}

	const openResultFolder = async () => {
		if (!result) return

		try {
			await window.fsdecryptGUI.openOutputFolder(result.outputRoot, result.outputSegments)
		} catch (error) {
			appendLog(error instanceof Error ? `Could not open output folder: ${error.message}` : "Could not open output folder")
		}
	}

	const openHistoryFolder = async (item: ExportHistoryItem) => {
		if (!item.outputRoot || !item.outputSegments) return

		try {
			await window.fsdecryptGUI.openOutputFolder(item.outputRoot, item.outputSegments)
		} catch (error) {
			appendLog(error instanceof Error ? `Could not open history folder: ${error.message}` : "Could not open history folder")
		}
	}

	const run = async () => {
		if (!canRun) return

		const abortController = new AbortController()
		abortControllerRef.current = abortController
		runStartedAtRef.current = performance.now()
		setIsBusy(true)
		setProgress(0)
		setRunStats({ elapsedMs: 0, bytesWritten: 0, totalBytes: 0 })
		setActiveJob(null)
		setLogs([])
		setResult(null)

		const elapsedDetails = (): CompletedResult["details"] => {
			const ms = performance.now() - runStartedAtRef.current
			const value = formatDuration(ms)
			return [{ label: "Elapsed", value }]
		}
		const noteBytesWritten = (bytes: number) => {
			setRunStats(current => ({
				...current,
				bytesWritten: current.bytesWritten + bytes,
				elapsedMs: performance.now() - runStartedAtRef.current
			}))
		}
		const extractionContext = {
			outputRoot,
			keySource,
			optionFiles,
			appendLog,
			setProgress,
			setRunStats
		}

		const jobs =
			mode === "vhd"
				? mergeGroups.map(group => ({
						label: group.label,
						sources: group.files.map(file => file.name),
						run: () => runMergeExport(extractionContext, group, elapsedDetails, abortController.signal, noteBytesWritten)
					}))
				: selectedContainerFiles.map(file => ({
						label: stripExtension(file.name),
						sources: [file.name],
						run: () =>
							mode === "option"
								? runOptionExport(extractionContext, file, elapsedDetails, abortController.signal, noteBytesWritten)
								: runBaseExport(extractionContext, file, elapsedDetails, abortController.signal, noteBytesWritten)
					}))

		try {
			appendLog(`Starting ${modeLabel} batch with ${jobs.length.toLocaleString()} export(s)`)
			let successfulJobs = 0
			let failedJobs = 0

			for (let index = 0; index < jobs.length; index++) {
				const job = jobs[index]
				const jobStartedAt = performance.now()
				setProgress(0)
				setActiveJob({ index: index + 1, total: jobs.length, label: job.label })
				appendLog(`[${index + 1}/${jobs.length}] Exporting ${job.label}`)

				try {
					const nextResult = await job.run()
					setResult(nextResult)
					setProgress(100)
					addHistory({
						status: "success",
						mode,
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
						addHistory({
							status: "cancelled",
							mode,
							label: job.label,
							sources: job.sources,
							durationMs: performance.now() - jobStartedAt,
							error: "Cancelled"
						})
						throw error
					}

					const message = error instanceof Error ? error.message : "fsdecrypt failed"
					appendLog(`ERROR: ${job.label}: ${message}`)
					failedJobs += 1
					addHistory({
						status: "failed",
						mode,
						label: job.label,
						sources: job.sources,
						durationMs: performance.now() - jobStartedAt,
						error: message
					})
				}
			}

			appendLog("Done")
			if (failedJobs > 0) {
				await notifyUser("fsdecryptGUI finished with errors", `${successfulJobs}/${jobs.length} export(s) completed. ${failedJobs} failed.`)
			} else {
				await notifyUser("fsdecryptGUI extraction complete", `${successfulJobs}/${jobs.length} export(s) completed.`)
			}
		} catch (error) {
			console.error(error)
			if (isAbortError(error)) {
				setProgress(0)
				appendLog("Cancelled")
				await notifyUser("fsdecryptGUI extraction cancelled", "The current extraction was cancelled.")
			} else {
				appendLog(error instanceof Error ? `ERROR: ${error.message}` : "ERROR: fsdecrypt failed")
				await notifyUser("fsdecryptGUI extraction failed", error instanceof Error ? error.message : "fsdecrypt failed")
			}
		} finally {
			abortControllerRef.current = null
			setIsBusy(false)
			setActiveJob(null)
		}
	}

	return (
		<AppView
			mode={mode}
			modeLabel={modeLabel}
			isBusy={isBusy}
			canRun={canRun}
			selectedJobCount={selectedJobCount}
			baseGroups={baseGroups}
			optionGroups={optionGroups}
			mergeGroups={mergeGroups}
			isAnalyzingBase={isAnalyzingBase}
			isAnalyzingOptions={isAnalyzingOptions}
			isAnalyzingMerge={isAnalyzingMerge}
			keyFile={keyFile}
			keyValidation={keyValidation}
			outputRoot={outputRoot}
			configPath={configPath}
			configFolder={configFolder}
			history={history}
			result={result}
			progress={progress}
			runStats={runStats}
			activeJob={activeJob}
			logs={logs}
			terminalRef={terminalRef}
			onModeChange={next => {
				setMode(next)
				setResult(null)
			}}
			onRun={run}
			onCancelRun={cancelRun}
			onReset={reset}
			onChooseApps={chooseApps}
			onChooseContainer={chooseContainer}
			onChooseKey={chooseKey}
			onClearKey={clearKey}
			onRemoveBaseFile={removeBaseFile}
			onRemoveOptionFile={removeOptionFile}
			onRemoveMergeFile={removeMergeFile}
			onSelectOutputFolder={selectOutputFolder}
			onOpenOutputRootFolder={openOutputRootFolder}
			onOpenConfigFolder={openConfigFolder}
			onOpenResultFolder={openResultFolder}
			onOpenHistoryFolder={openHistoryFolder}
			onClearHistory={clearHistory}
			onCopyLogs={copyLogs}
			onSaveLogs={saveLogs}
		/>
	)
}
