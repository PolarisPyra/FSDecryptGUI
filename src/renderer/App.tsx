import { useEffect, useMemo, useRef, useState } from "react"

import type { ReadableByteSource } from "../fsdecrypt/byte-source"
import { isAbortError } from "./base/common/cancellation"
import { formatDuration, formatLogExport, logExportName } from "./base/common/format"
import { dirname, pathInFolder, stripExtension } from "./base/common/path"
import { PickedFile, RendererConfig, ScannedInputFolder, byteSourceFromPickedFile } from "./electron-api"
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

type RunScope = "all" | ToolMode

export function App() {
	const [mode, setMode] = useState<ToolMode>("container")
	const [inputRoot, setInputRoot] = useState("")
	const [inputFolderActive, setInputFolderActive] = useState(false)
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

	const allJobCount = baseFiles.length + optionFiles.length + mergeGroups.length
	const modeJobCounts: Record<ToolMode, number> = {
		container: baseFiles.length,
		option: optionFiles.length,
		vhd: mergeGroups.length
	}
	const modeWarningState: Record<ToolMode, boolean> = {
		container: baseGroups.some(group => group.warning),
		option: optionGroups.some(group => group.warning),
		vhd: mergeGroups.some(group => group.warning)
	}
	const modeScopesWithJobs = MODES.map(item => item.mode).filter(item => modeJobCounts[item] > 0)
	const hasMultipleModeJobs = modeScopesWithJobs.length > 1
	const runScopeOptions: RunScope[] = allJobCount > 0 && hasMultipleModeJobs ? ["all", ...modeScopesWithJobs] : []
	const [runScope, setRunScope] = useState<RunScope>("container")
	const firstModeWithJobs = modeScopesWithJobs[0] ?? mode
	const effectiveRunScope =
		runScope === "all"
			? "all"
			: modeJobCounts[runScope] > 0
				? runScope
				: inputFolderActive && allJobCount > 0
					? "all"
					: firstModeWithJobs
	const effectiveJobCount = effectiveRunScope === "all" ? allJobCount : modeJobCounts[effectiveRunScope]
	const allWarnings = Object.values(modeWarningState).some(Boolean)
	const keyValidation = useMemo(() => validateKeyFile(keyFile), [keyFile])
	const canRun =
		!isBusy &&
		Boolean(outputRoot) &&
		effectiveJobCount > 0 &&
		!(effectiveRunScope === "all" ? allWarnings : modeWarningState[effectiveRunScope]) &&
		keyValidation.status !== "invalid" &&
		!isAnalyzingMerge &&
		!isAnalyzingOptions &&
		!isAnalyzingBase
	const modeLabel = MODES.find(item => item.mode === mode)!.label.toUpperCase()
	const effectiveScopeLabel = effectiveRunScope === "all" ? "ALL" : MODES.find(item => item.mode === effectiveRunScope)!.label.toUpperCase()
	const keySource = useMemo(() => (keyFile ? byteSourceFromPickedFile(keyFile) : undefined), [keyFile])
	const configFolder = useMemo(() => dirname(configPath), [configPath])
	const runButtonLabel =
		effectiveRunScope === "all"
			? `Extract All${effectiveJobCount > 1 ? ` ${effectiveJobCount}` : ""}`
			: `Extract ${effectiveScopeLabel}${effectiveJobCount > 1 ? ` ${effectiveJobCount}` : ""}`

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
		let cancelled = false
		const applyConfig = (config: RendererConfig) => {
			setInputRoot(config.inputRoot ?? "")
			setOutputRoot(config.outputRoot ?? "")
			setKeyFile(config.keyFile ?? null)
			setConfigPath(config.configPath)
		}

		const scanConfiguredInput = async (config: RendererConfig) => {
			if (!config.inputRoot) return

			try {
				const scan = await window.fsdecryptGUI.scanInputFolder(config.inputRoot)
				if (cancelled) return
				await applyInputScan(scan, config.keyFile ? byteSourceFromPickedFile(config.keyFile) : undefined)
			} catch (error) {
				if (!cancelled) {
					appendLog(error instanceof Error ? `Could not scan configured input folder: ${error.message}` : "Could not scan configured input folder")
				}
			}
		}

		window.fsdecryptGUI
			.readConfig()
			.then(config => {
				if (cancelled) return
				applyConfig(config)
				void scanConfiguredInput(config)
			})
			.catch(error => {
				appendLog(error instanceof Error ? `Could not read config: ${error.message}` : "Could not read config")
			})

		const removeConfigListener = window.fsdecryptGUI.onConfigChanged(config => {
			applyConfig(config)
			appendLog("Configuration updated")
		})

		return () => {
			cancelled = true
			removeConfigListener()
		}
	}, [])

	async function applyInputScan(scan: ScannedInputFolder, scanKeySource: ReadableByteSource | undefined = keySource) {
		setInputRoot(scan.rootPath)
		setInputFolderActive(true)
		setBaseGroups([])
		setOptionGroups([])
		setMergeGroups([])
		setResult(null)

		setIsAnalyzingBase(true)
		setIsAnalyzingOptions(true)
		setIsAnalyzingMerge(true)
		try {
			const appGroups = await buildBaseGroups(scan.files.apps, scanKeySource)
			const basePaths = new Set<string>()
			const mergePaths = new Set(scan.files.vhds.map(file => file.path))
			for (const group of appGroups) {
				const target = group.hasChildLayer || group.rawVhds.length > 0 ? mergePaths : basePaths
				for (const file of group.files) {
					target.add(file.path)
				}
			}

			const allAppFilesByPath = new Map(scan.files.apps.map(file => [file.path, file]))
			const nextBaseFiles = [...basePaths].map(path => allAppFilesByPath.get(path)).filter((file): file is PickedFile => Boolean(file))
			const nextMergeFiles = [
				...scan.files.apps.filter(file => mergePaths.has(file.path)),
				...scan.files.vhds
			]
			setBaseFiles(nextBaseFiles)
			setOptionFiles(scan.files.options)
			setMergeFiles(nextMergeFiles)

			const [nextBaseGroups, nextOptionGroups, nextMergeGroups] = await Promise.all([
				buildBaseGroups(nextBaseFiles, scanKeySource),
				buildOptionGroups(scan.files.options, scanKeySource),
				buildMergeGroups(nextMergeFiles, scanKeySource)
			])
			setBaseGroups(nextBaseGroups)
			setOptionGroups(nextOptionGroups)
			setMergeGroups(nextMergeGroups)
			const detectedModes = [
				nextBaseFiles.length > 0,
				scan.files.options.length > 0,
				nextMergeGroups.length > 0
			].filter(Boolean).length
			const firstDetectedMode: ToolMode =
				nextBaseFiles.length > 0 ? "container" : scan.files.options.length > 0 ? "option" : nextMergeGroups.length > 0 ? "vhd" : mode
			setMode(firstDetectedMode)
			setRunScope(detectedModes > 0 ? "all" : firstDetectedMode)
			appendLog(
				`Input folder scanned: ${nextBaseFiles.length.toLocaleString()} base APP(s), ${scan.files.options.length.toLocaleString()} OPTION(s), ${nextMergeFiles.length.toLocaleString()} merge file(s)`
			)
		} finally {
			setIsAnalyzingBase(false)
			setIsAnalyzingOptions(false)
			setIsAnalyzingMerge(false)
		}
	}

	const selectInputFolder = async () => {
		try {
			const scan = await window.fsdecryptGUI.selectInputFolder()
			if (!scan) return
			await applyInputScan(scan)
		} catch (error) {
			appendLog(error instanceof Error ? `Could not scan input folder: ${error.message}` : "Could not scan input folder")
		}
	}

	useEffect(() => {
		return window.fsdecryptGUI.onInputFolderScanned(scan => {
			void applyInputScan(scan)
		})
	}, [keySource])

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

		setInputFolderActive(false)
		setInputRoot("")
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

	const moveBaseGroupToMerge = async (group: BaseSelectionGroup) => {
		if (isBusy) return

		const movingPaths = new Set(group.files.map(file => file.path))
		const nextBaseFiles = baseFiles.filter(file => !movingPaths.has(file.path))
		const nextMergeFiles = appendPickedFiles(mergeFiles, group.files)
		setBaseFiles(nextBaseFiles)
		setMergeFiles(nextMergeFiles)
		setBaseGroups([])
		setMergeGroups([])
		setResult(null)

		setIsAnalyzingBase(true)
		setIsAnalyzingMerge(true)
		try {
			const [nextBaseGroups, nextMergeGroups] = await Promise.all([
				buildBaseGroups(nextBaseFiles, keySource),
				buildMergeGroups(nextMergeFiles, keySource)
			])
			setBaseGroups(nextBaseGroups)
			setMergeGroups(nextMergeGroups)
			setMode("vhd")
			setRunScope("vhd")
			appendLog(`Moved ${group.label} to Merge`)
		} catch (error) {
			appendLog(error instanceof Error ? `Could not move selection to Merge: ${error.message}` : "Could not move selection to Merge")
		} finally {
			setIsAnalyzingBase(false)
			setIsAnalyzingMerge(false)
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

		setInputFolderActive(false)
		setInputRoot("")
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
		setInputRoot("")
		setInputFolderActive(false)
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
		setRunScope("container")
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

		const baseJobs = baseFiles.map(file => ({
			mode: "container" as ToolMode,
			label: stripExtension(file.name),
			sources: [file.name],
			run: () => runBaseExport(extractionContext, file, elapsedDetails, abortController.signal, noteBytesWritten)
		}))
		const optionJobs = optionFiles.map(file => ({
			mode: "option" as ToolMode,
			label: stripExtension(file.name),
			sources: [file.name],
			run: () => runOptionExport(extractionContext, file, elapsedDetails, abortController.signal, noteBytesWritten)
		}))
		const mergeJobs = mergeGroups.map(group => ({
			mode: "vhd" as ToolMode,
			label: group.label,
			sources: group.files.map(file => file.name),
			run: () => runMergeExport(extractionContext, group, elapsedDetails, abortController.signal, noteBytesWritten)
		}))
		const jobs =
			effectiveRunScope === "all"
				? [...baseJobs, ...optionJobs, ...mergeJobs]
				: effectiveRunScope === "vhd"
					? mergeJobs
					: effectiveRunScope === "option"
						? optionJobs
						: baseJobs

		try {
			appendLog(`Starting ${effectiveScopeLabel} batch with ${jobs.length.toLocaleString()} export(s)`)
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
						addHistory({
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
					appendLog(`ERROR: ${job.label}: ${message}`)
					failedJobs += 1
					addHistory({
						status: "failed",
						mode: job.mode,
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
			runButtonLabel={runButtonLabel}
			runScope={effectiveRunScope}
			hasMultipleModeJobs={hasMultipleModeJobs}
			runScopeOptions={runScopeOptions}
			onRunScopeChange={setRunScope}
			selectedJobCount={effectiveJobCount}
			baseGroups={baseGroups}
			optionGroups={optionGroups}
			mergeGroups={mergeGroups}
			isAnalyzingBase={isAnalyzingBase}
			isAnalyzingOptions={isAnalyzingOptions}
			isAnalyzingMerge={isAnalyzingMerge}
			keyFile={keyFile}
			keyValidation={keyValidation}
			outputRoot={outputRoot}
			inputRoot={inputRoot}
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
				setRunScope(next)
				setResult(null)
			}}
			onRun={run}
			onCancelRun={cancelRun}
			onReset={reset}
			onChooseApps={chooseApps}
			onChooseContainer={chooseContainer}
			onChooseKey={chooseKey}
			onSelectInputFolder={selectInputFolder}
			onClearKey={clearKey}
			onRemoveBaseFile={removeBaseFile}
			onRemoveOptionFile={removeOptionFile}
			onRemoveMergeFile={removeMergeFile}
			onMoveBaseGroupToMerge={moveBaseGroupToMerge}
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
