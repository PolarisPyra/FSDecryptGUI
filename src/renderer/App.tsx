import { useEffect, useMemo, useRef, useState } from "react"

import type { ReadableByteSource } from "../fsdecrypt/byte-source"
import { formatLogExport, logExportName } from "./base/common/format"
import { dirname, pathInFolder } from "./base/common/path"
import { PickedFile, RendererConfig, ScannedInputFolder, byteSourceFromPickedFile } from "./electron-api"
import { AppView } from "./app/browser/appView"
import { MODES } from "./app/common/modes"
import type {
	BaseSelectionGroup,
	AppScreen,
	CompletedResult,
	ExportHistoryItem,
	RunStats,
	ThemeMode,
	ToolMode
} from "./app/common/appTypes"
import { runExtractionBatch } from "./app/services/extractionBatch"
import { historyId, readStoredHistory, writeStoredHistory } from "./app/services/historyStorage"
import {
	analyzeInputScan,
	appendToSelectionQueue,
	emptySelectionQueues,
	moveBaseGroupToMergeQueue,
	refreshSelectionQueues,
	removeFromSelectionQueue,
	selectModeSelectionGroups,
	selectSelectionGroup,
	selectionSummary,
	type SelectionQueues,
	validateKeyFile
} from "./app/services/selectionQueue"

/** Builds the default per-mode analysis state used before file metadata scans start. */
function idleSelectionAnalysis(): Record<ToolMode, boolean> {
	return { container: false, option: false, vhd: false }
}

/** Marks one mode, or every mode, as actively analyzing selected files. */
function activeSelectionAnalysis(mode?: ToolMode): Record<ToolMode, boolean> {
	if (!mode) return { container: true, option: true, vhd: true }
	return { ...idleSelectionAnalysis(), [mode]: true }
}

const THEME_STORAGE_KEY = "fsdecryptGUI.theme"

function readStoredTheme(): ThemeMode {
	return localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark"
}

/** Owns renderer application state and wires the pure services to the browser/Electron view. */
export function App() {
	const [theme, setTheme] = useState<ThemeMode>(readStoredTheme)
	const [screen, setScreen] = useState<AppScreen>("extract")
	const [mode, setMode] = useState<ToolMode>("container")
	const [inputRoot, setInputRoot] = useState("")
	const [queues, setQueues] = useState<SelectionQueues>(emptySelectionQueues)
	const [selectionAnalysis, setSelectionAnalysis] = useState<Record<ToolMode, boolean>>(idleSelectionAnalysis)
	const [keyFile, setKeyFile] = useState<PickedFile | null>(null)
	const [outputRoot, setOutputRoot] = useState("")
	const [configPath, setConfigPath] = useState("")
	const [isBusy, setIsBusy] = useState(false)
	const [progress, setProgress] = useState(0)
	const [runStats, setRunStats] = useState<RunStats>({ elapsedMs: 0, bytesWritten: 0, totalBytes: 0 })
	const [logs, setLogs] = useState<string[]>(["Ready"])
	const [result, setResult] = useState<CompletedResult | null>(null)
	const [activeJob, setActiveJob] = useState<{ index: number; total: number; label: string } | null>(null)
	const [history, setHistory] = useState<ExportHistoryItem[]>(readStoredHistory)
	const [runAllModes, setRunAllModes] = useState(false)
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
		document.documentElement.dataset.appTheme = theme
		document.documentElement.classList.toggle("dark", theme === "dark")
		localStorage.setItem(THEME_STORAGE_KEY, theme)
	}, [theme])

	useEffect(() => {
		if (!isBusy) return

		const interval = window.setInterval(() => {
			setRunStats(current => ({ ...current, elapsedMs: performance.now() - runStartedAtRef.current }))
		}, 250)

		return () => window.clearInterval(interval)
	}, [isBusy])

	const selection = selectionSummary(queues, mode, runAllModes)
	const isAnalyzingBase = selectionAnalysis.container
	const isAnalyzingOptions = selectionAnalysis.option
	const isAnalyzingMerge = selectionAnalysis.vhd
	const keyValidation = useMemo(() => validateKeyFile(keyFile), [keyFile])
	const canRun =
		!isBusy &&
		Boolean(outputRoot) &&
		selection.effectiveJobCount > 0 &&
		!selection.hasBlockingWarnings &&
		keyValidation.status !== "invalid" &&
		!isAnalyzingMerge &&
		!isAnalyzingOptions &&
		!isAnalyzingBase
	const modeLabel = MODES.find(item => item.mode === mode)!.label.toUpperCase()
	const effectiveScopeLabel = selection.effectiveRunScope === "all" ? "ALL" : MODES.find(item => item.mode === selection.effectiveRunScope)!.label.toUpperCase()
	const keySource = useMemo(() => (keyFile ? byteSourceFromPickedFile(keyFile) : undefined), [keyFile])
	const configFolder = useMemo(() => dirname(configPath), [configPath])
	const runButtonLabel =
		selection.effectiveRunScope === "all"
			? `Extract All${selection.effectiveJobCount > 1 ? ` ${selection.effectiveJobCount}` : ""}`
			: `Extract ${effectiveScopeLabel}${selection.effectiveJobCount > 1 ? ` ${selection.effectiveJobCount}` : ""}`

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

	const setGroupSelected = (targetMode: ToolMode, groupId: string, selected: boolean) => {
		setQueues(current => selectSelectionGroup(current, targetMode, groupId, selected))
		setResult(null)
	}

	const setModeGroupsSelected = (targetMode: ToolMode, selected: boolean) => {
		setQueues(current => selectModeSelectionGroups(current, targetMode, selected))
		setResult(null)
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
		setQueues(emptySelectionQueues())
		setResult(null)

		setSelectionAnalysis(activeSelectionAnalysis())
		try {
			const next = await analyzeInputScan(scan, scanKeySource, mode)
			setQueues(next.queues)
			setMode(next.nextMode)
			setRunAllModes(next.runAllModes)
			appendLog(next.logMessage)
		} finally {
			setSelectionAnalysis(idleSelectionAnalysis())
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

		setInputRoot("")
		const targetMode: ToolMode = isOption ? "option" : "container"
		setSelectionAnalysis(activeSelectionAnalysis(targetMode))
		if (isOption) {
			try {
				setQueues(await appendToSelectionQueue(queues, "option", files, keySource))
			} catch (error) {
				appendLog(error instanceof Error ? `Could not analyze OPTION VHD selection: ${error.message}` : "Could not analyze OPTION VHD selection")
			} finally {
				setSelectionAnalysis(idleSelectionAnalysis())
			}
		} else {
			try {
				setQueues(await appendToSelectionQueue(queues, "container", files, keySource))
			} catch (error) {
				appendLog(error instanceof Error ? `Could not analyze APP selection: ${error.message}` : "Could not analyze APP selection")
			} finally {
				setSelectionAnalysis(idleSelectionAnalysis())
			}
		}
		setResult(null)
	}

	const refreshSelectionsForKey = async (nextKeySource: ReadableByteSource | undefined) => {
		setSelectionAnalysis(activeSelectionAnalysis())
		try {
			setQueues(await refreshSelectionQueues(queues, nextKeySource))
		} catch (error) {
			appendLog(error instanceof Error ? `Could not refresh selections: ${error.message}` : "Could not refresh selections")
		} finally {
			setSelectionAnalysis(idleSelectionAnalysis())
		}
	}

	const moveBaseGroupToMerge = async (group: BaseSelectionGroup) => {
		if (isBusy) return

		setResult(null)

		setSelectionAnalysis({ ...idleSelectionAnalysis(), container: true, vhd: true })
		try {
			setQueues(await moveBaseGroupToMergeQueue(queues, group, keySource))
			setMode("vhd")
			setRunAllModes(false)
			appendLog(`Moved ${group.label} to Merge`)
		} catch (error) {
			appendLog(error instanceof Error ? `Could not move selection to Merge: ${error.message}` : "Could not move selection to Merge")
		} finally {
			setSelectionAnalysis(idleSelectionAnalysis())
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

		setInputRoot("")
		setResult(null)

		setSelectionAnalysis(activeSelectionAnalysis("vhd"))
		try {
			setQueues(await appendToSelectionQueue(queues, "vhd", files, keySource))
		} catch (error) {
			appendLog(error instanceof Error ? `Could not analyze merge selection: ${error.message}` : "Could not analyze merge selection")
		} finally {
			setSelectionAnalysis(idleSelectionAnalysis())
		}
	}

	const removeBaseFile = async (path: string) => {
		if (isBusy) return

		setResult(null)

		setSelectionAnalysis(activeSelectionAnalysis("container"))
		try {
			setQueues(await removeFromSelectionQueue(queues, "container", path, keySource))
		} catch (error) {
			appendLog(error instanceof Error ? `Could not analyze APP selection: ${error.message}` : "Could not analyze APP selection")
		} finally {
			setSelectionAnalysis(idleSelectionAnalysis())
		}
	}

	const removeOptionFile = async (path: string) => {
		if (isBusy) return

		setResult(null)

		setSelectionAnalysis(activeSelectionAnalysis("option"))
		try {
			setQueues(await removeFromSelectionQueue(queues, "option", path, keySource))
		} catch (error) {
			appendLog(error instanceof Error ? `Could not analyze OPTION VHD selection: ${error.message}` : "Could not analyze OPTION VHD selection")
		} finally {
			setSelectionAnalysis(idleSelectionAnalysis())
		}
	}

	const removeMergeFile = async (path: string) => {
		if (isBusy) return

		setResult(null)

		setSelectionAnalysis(activeSelectionAnalysis("vhd"))
		try {
			setQueues(await removeFromSelectionQueue(queues, "vhd", path, keySource))
		} catch (error) {
			appendLog(error instanceof Error ? `Could not analyze merge selection: ${error.message}` : "Could not analyze merge selection")
		} finally {
			setSelectionAnalysis(idleSelectionAnalysis())
		}
	}

	const reset = () => {
		setInputRoot("")
		setQueues(emptySelectionQueues())
		setSelectionAnalysis(idleSelectionAnalysis())
		setProgress(0)
		setRunStats({ elapsedMs: 0, bytesWritten: 0, totalBytes: 0 })
		setActiveJob(null)
		setLogs(["Ready"])
		setResult(null)
		setRunAllModes(false)
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
		const startedAt = performance.now()
		runStartedAtRef.current = startedAt
		setIsBusy(true)
		setProgress(0)
		setRunStats({ elapsedMs: 0, bytesWritten: 0, totalBytes: 0 })
		setActiveJob(null)
		setLogs([])
		setResult(null)

		try {
				await runExtractionBatch({
					queues,
					runScope: selection.effectiveRunScope,
					scopeLabel: effectiveScopeLabel,
					outputRoot,
					keySource,
					signal: abortController.signal,
					startedAt,
					events: {
						appendLog,
						addHistory,
						notifyUser,
						setActiveJob,
						setProgress,
						setResult,
						setRunStats
					}
				})
		} finally {
			abortControllerRef.current = null
			setIsBusy(false)
			setActiveJob(null)
		}
	}

	return (
		<AppView
			screen={screen}
			mode={mode}
			theme={theme}
			modeLabel={modeLabel}
			isBusy={isBusy}
			canRun={canRun}
			runButtonLabel={runButtonLabel}
			runAllModes={runAllModes && selection.hasMultipleModeJobs}
			hasMultipleModeJobs={selection.hasMultipleModeJobs}
			onRunAllModesChange={setRunAllModes}
			selectedJobCount={selection.effectiveJobCount}
			baseGroups={queues.container.groups}
			optionGroups={queues.option.groups}
			mergeGroups={queues.vhd.groups}
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
			queues={queues}
			terminalRef={terminalRef}
			onScreenChange={setScreen}
			onToggleGroupSelected={setGroupSelected}
			onSetModeGroupsSelected={setModeGroupsSelected}
			onModeChange={next => {
				setMode(next)
				setResult(null)
			}}
			onToggleTheme={() => setTheme(current => (current === "dark" ? "light" : "dark"))}
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
