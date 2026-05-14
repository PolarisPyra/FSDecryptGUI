import { useEffect, useMemo, useRef, useState } from "react"

import {
	AlertTriangle,
	CheckCircle2,
	CircleDot,
	FileArchive,
	FileKey,
	FolderOpen,
	FolderPlus,
	HardDriveDownload,
	History,
	Link2,
	RotateCcw,
	Terminal,
	Trash2,
	X,
	Zap
} from "lucide-react"

import type { ReadableByteSource } from "../fsdecrypt/byte-source"
import type { FscryptBootId } from "../fsdecrypt/fsdecrypt"
import type { NtfsExtractionWriter } from "../fsdecrypt/ntfs"
import type { VhdNtfsSource } from "../fsdecrypt/vhd"
import { PickedFile, RendererConfig, byteSourceFromPickedFile } from "./electron-api"

type ToolMode = "container" | "option" | "vhd"
type HistoryStatus = "success" | "failed" | "cancelled"

type CompletedResult = {
	outputFolder: string
	outputSegments: string[]
	outputRoot: string
	outputSize: number
	details: Array<{ label: string; value: string }>
}

type RunStats = {
	elapsedMs: number
	bytesWritten: number
	totalBytes: number
}

type VersionLike = {
	major: number
	minor: number
	release: number
}

type AppLayerInfo = {
	file: PickedFile
	bootId?: FscryptBootId
	error?: string
	parentFile?: PickedFile
}

type MergeSelectionGroup = {
	id: string
	label: string
	files: PickedFile[]
	appLayers: AppLayerInfo[]
	rawVhds: PickedFile[]
	warning?: string
}

type ExportHistoryItem = {
	id: string
	status: HistoryStatus
	mode: ToolMode
	label: string
	sources: string[]
	outputFolder?: string
	outputSegments?: string[]
	outputRoot?: string
	outputSize?: number
	durationMs: number
	completedAt: string
	error?: string
}

const WRITE_CHUNK_SIZE = 32 * 1024 * 1024
const HISTORY_STORAGE_KEY = "fsdecryptGUI.exportHistory"

const MODES = [
	{ mode: "container" as const, label: "Base", icon: FileArchive },
	{ mode: "option" as const, label: "Option", icon: FileKey },
	{ mode: "vhd" as const, label: "Merge", icon: HardDriveDownload }
]

function formatBytes(bytes: number) {
	const units = ["B", "KB", "MB", "GB", "TB"]
	let value = bytes
	let unitIndex = 0
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024
		unitIndex += 1
	}
	return `${value.toLocaleString(undefined, { maximumFractionDigits: unitIndex === 0 ? 0 : 2 })} ${units[unitIndex]}`
}

function basename(filePath: string) {
	const segments = filePath.split(/[\\/]/).filter(Boolean)
	return segments.length > 0 ? segments[segments.length - 1] : filePath
}

function outputSegmentsForFolder(rootPath: string, folderName: string) {
	const outputFolder = sanitizePathSegment(folderName)
	return basename(rootPath) === outputFolder ? [] : [outputFolder]
}

function dirname(filePath: string) {
	const separatorIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
	return separatorIndex > 0 ? filePath.slice(0, separatorIndex) : ""
}

function compactPath(filePath: string, visibleSegments = 2) {
	const normalized = filePath.replace(/\\/g, "/")
	const prefix = normalized.startsWith("/") ? "/" : ""
	const segments = normalized.split("/").filter(Boolean)
	if (segments.length <= visibleSegments) {
		return filePath
	}

	return `${prefix}.../${segments.slice(-visibleSegments).join("/")}`
}

function sanitizePathSegment(name: string) {
	return Array.from(name, character => {
		const code = character.charCodeAt(0)
		return code < 32 || '<>:"/\\|?*'.includes(character) ? "_" : character
	}).join("")
}

function stripExtension(name: string) {
	return name.replace(/\.[^.]+$/, "")
}

function formatDuration(ms: number) {
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)}s`
	}

	return `${Math.floor(ms / 60_000)}m ${((ms % 60_000) / 1000).toFixed(0)}s`
}

function formatThroughput(bytes: number, elapsedMs: number) {
	if (bytes <= 0 || elapsedMs <= 0) {
		return "0 B/s"
	}

	return `${formatBytes((bytes / elapsedMs) * 1000)}/s`
}

function formatEta(stats: RunStats) {
	if (stats.bytesWritten <= 0 || stats.totalBytes <= 0 || stats.bytesWritten >= stats.totalBytes) {
		return "..."
	}

	const bytesPerMs = stats.bytesWritten / Math.max(stats.elapsedMs, 1)
	return formatDuration((stats.totalBytes - stats.bytesWritten) / bytesPerMs)
}

function formatVersion(version: VersionLike) {
	return `${version.major}.${version.minor.toString().padStart(2, "0")}.${version.release.toString().padStart(2, "0")}`
}

function versionKey(version: VersionLike) {
	return `${version.major}.${version.minor}.${version.release}`
}

function appLayerLabel(layer: AppLayerInfo) {
	if (!layer.bootId) {
		return "Unknown APP"
	}

	return `${layer.bootId.gameId} ${formatVersion(layer.bootId.targetVersion)}`
}

function historyId() {
	return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function abortError() {
	return new DOMException("Extraction cancelled", "AbortError")
}

function throwIfAborted(signal: AbortSignal) {
	if (signal.aborted) {
		throw abortError()
	}
}

function isAbortError(error: unknown) {
	return (error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && error.message === "Extraction cancelled")
}

function readStoredHistory(): ExportHistoryItem[] {
	try {
		const raw = localStorage.getItem(HISTORY_STORAGE_KEY)
		if (!raw) return []
		const parsed = JSON.parse(raw) as ExportHistoryItem[]
		return Array.isArray(parsed) ? parsed.slice(0, 50) : []
	} catch {
		return []
	}
}

function writeStoredHistory(history: ExportHistoryItem[]) {
	localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, 50)))
}

function vhdDetails(result: VhdNtfsSource) {
	return [
		{ label: "Layers", value: result.chain.length.toString() },
		{ label: "Parent", value: result.chain[0] ?? "" },
		{ label: "Child", value: result.chain[result.chain.length - 1] ?? "" },
		{ label: "NTFS Offset", value: formatBytes(result.ntfsOffset) }
	]
}

function createFolderWriter(
	rootPath: string,
	folderName: string,
	getTotalBytes: () => number,
	setProgress: (progress: number) => void,
	signal: AbortSignal,
	onBytesWritten: (bytes: number) => void
): NtfsExtractionWriter {
	let written = 0
	let lastProgressUpdate = 0
	const outputFolder = sanitizePathSegment(folderName)
	const outputRoot = outputSegmentsForFolder(rootPath, outputFolder)
	const writePath = (path: string[]) => [...outputRoot, ...path.map(sanitizePathSegment)]

	const writeFile = async (path: string[], source: ReadableByteSource) => {
		const target = writePath(path)
		let wroteChunk = false

		try {
			for (let offset = 0; offset < source.size; offset += WRITE_CHUNK_SIZE) {
				throwIfAborted(signal)
				const chunk = await source.read(offset, Math.min(WRITE_CHUNK_SIZE, source.size - offset))
				throwIfAborted(signal)
				await window.fsdecryptGUI.writeFileChunk(rootPath, target, chunk, wroteChunk)
				wroteChunk = true
				written += chunk.length
				onBytesWritten(chunk.length)

				const now = performance.now()
				if (now - lastProgressUpdate > 250 || offset + chunk.length >= source.size) {
					lastProgressUpdate = now
					setProgress(Math.min(99, Math.round((written / Math.max(getTotalBytes(), 1)) * 100)))
				}
			}

			if (!wroteChunk) {
				throwIfAborted(signal)
				await window.fsdecryptGUI.writeFileChunk(rootPath, target, new Uint8Array(), false)
			}
		} finally {
			await window.fsdecryptGUI.closeOutputFile(rootPath, target)
		}
	}

	return {
		createDirectory: path => {
			throwIfAborted(signal)
			return window.fsdecryptGUI.ensureDirectory(rootPath, writePath(path))
		},
		writeFile
	}
}

async function inspectAppLayers(files: PickedFile[], keySource: ReadableByteSource | undefined): Promise<AppLayerInfo[]> {
	const appFiles = files.filter(file => file.name.toLowerCase().endsWith(".app"))
	const { openFscryptSource } = await import("../fsdecrypt/fsdecrypt")
	const layers = await Promise.all(
		appFiles.map(async file => {
			try {
				const source = await openFscryptSource(byteSourceFromPickedFile(file), { keyFile: keySource })
				return { file, bootId: source.bootId }
			} catch (error) {
				return { file, error: error instanceof Error ? error.message : "Could not read APP metadata" }
			}
		})
	)

	return layers.map(layer => {
		if (!layer.bootId || layer.bootId.sequenceNumber === 0) {
			return layer
		}

		const parent = layers.find(candidate => {
			return (
				candidate.bootId &&
				candidate.bootId.gameId === layer.bootId?.gameId &&
				versionKey(candidate.bootId.targetVersion) === versionKey(layer.bootId.sourceVersion)
			)
		})

		return { ...layer, parentFile: parent?.file }
	})
}

async function buildMergeGroups(files: PickedFile[], keySource: ReadableByteSource | undefined): Promise<MergeSelectionGroup[]> {
	const rawVhds = files.filter(file => file.name.toLowerCase().endsWith(".vhd"))
	const appLayers = await inspectAppLayers(files, keySource)
	const groups = new Map<string, AppLayerInfo[]>()

	for (const layer of appLayers) {
		let root = layer
		let guard = 0
		while (root.parentFile && guard < appLayers.length) {
			const nextRoot = appLayers.find(candidate => candidate.file.path === root.parentFile?.path)
			if (!nextRoot) break
			root = nextRoot
			guard += 1
		}

		const key = root.bootId
			? `${root.bootId.gameId}:${versionKey(root.bootId.targetVersion)}:${root.file.path}`
			: `unknown:${root.file.path}`
		groups.set(key, [...(groups.get(key) ?? []), layer])
	}

	const result: MergeSelectionGroup[] = [...groups.values()].map((layers, index) => {
		const sorted = [...layers].sort((left, right) => (left.bootId?.sequenceNumber ?? 0) - (right.bootId?.sequenceNumber ?? 0))
		const first = sorted[0]
		const last = sorted[sorted.length - 1]
		const missingParent = sorted.find(layer => layer.bootId && layer.bootId.sequenceNumber > 0 && !layer.parentFile)
		const hasErrors = sorted.find(layer => layer.error)
		const label = last?.bootId ? `${last.bootId.gameId} ${formatVersion(last.bootId.targetVersion)}` : `APP Chain ${index + 1}`

		return {
			id: sorted.map(layer => layer.file.path).join("|"),
			label,
			files: sorted.map(layer => layer.file),
			appLayers: sorted,
			rawVhds: [],
			warning: hasErrors
				? "Metadata read failed; extraction may still fail."
				: missingParent
					? `${first?.bootId?.gameId ?? "APP"} ${formatVersion(missingParent.bootId!.sourceVersion)} parent is not selected.`
					: undefined
		}
	})

	if (rawVhds.length > 0) {
		result.push({
			id: rawVhds.map(file => file.path).join("|"),
			label: rawVhds.length === 1 ? stripExtension(rawVhds[0].name) : `Raw VHD Chain (${rawVhds.length})`,
			files: rawVhds,
			appLayers: [],
			rawVhds,
			warning: appLayers.length > 0 ? "Raw VHD files are exported as a separate chain from selected APP files." : undefined
		})
	}

	return result
}

function ModeToggle({ mode, onChange }: { mode: ToolMode; onChange: (mode: ToolMode) => void }) {
	const activeIndex = MODES.findIndex(item => item.mode === mode)
	return (
		<div className="mode-toggle">
			<div className="mode-indicator" style={{ transform: `translateX(calc(${activeIndex} * (100% + 0.2rem)))` }} />
			{MODES.map(item => {
				const Icon = item.icon
				return (
					<button key={item.mode} type="button" className={mode === item.mode ? "active" : ""} onClick={() => onChange(item.mode)}>
						<Icon size={15} />
						<span>{item.label}</span>
					</button>
				)
			})}
		</div>
	)
}

function ContainerSelection({ files }: { files: PickedFile[] }) {
	if (files.length === 0) {
		return <div className="muted">None</div>
	}

	return (
		<div className="selected-list">
			{files.map((file, index) => (
				<div className="selected-card" key={file.path}>
					<div className="selected-card-index">{index + 1}</div>
					<div className="selected-card-body">
						<strong title={file.name}>{file.name}</strong>
						<span>{formatBytes(file.size)}</span>
					</div>
				</div>
			))}
		</div>
	)
}

function MergeSelection({ groups, isAnalyzing }: { groups: MergeSelectionGroup[]; isAnalyzing: boolean }) {
	if (isAnalyzing) {
		return <div className="muted">Reading APP chain metadata...</div>
	}

	if (groups.length === 0) {
		return <div className="muted">None</div>
	}

	return (
		<div className="selected-list">
			{groups.map((group, index) => (
				<div className="chain-card" key={group.id || index}>
					<div className="chain-card-header">
						<div>
							<label>{group.rawVhds.length > 0 ? "VHD Chain" : "APP Chain"}</label>
							<strong title={group.label}>{group.label}</strong>
						</div>
						<span>{group.files.length} layer{group.files.length === 1 ? "" : "s"}</span>
					</div>
					{group.warning && (
						<div className="chain-warning">
							<AlertTriangle size={14} />
							<span>{group.warning}</span>
						</div>
					)}
					<div className="chain-layers">
						{group.appLayers.map(layer => (
							<div className={layer.parentFile || layer.bootId?.sequenceNumber === 0 ? "chain-layer linked" : "chain-layer missing"} key={layer.file.path}>
								{layer.bootId?.sequenceNumber === 0 ? <CircleDot size={14} /> : layer.parentFile ? <Link2 size={14} /> : <AlertTriangle size={14} />}
								<div>
									<strong title={layer.file.name}>{layer.file.name}</strong>
									<span>
										{layer.error
											? layer.error
											: layer.bootId?.sequenceNumber === 0
												? `Parent layer · ${appLayerLabel(layer)}`
												: layer.parentFile
													? `Child layer · parent ${layer.parentFile.name}`
													: `Child layer · missing parent ${formatVersion(layer.bootId!.sourceVersion)}`}
									</span>
								</div>
							</div>
						))}
						{group.rawVhds.map(file => (
							<div className="chain-layer linked" key={file.path}>
								<HardDriveDownload size={14} />
								<div>
									<strong title={file.name}>{file.name}</strong>
									<span>{formatBytes(file.size)}</span>
								</div>
							</div>
						))}
					</div>
				</div>
			))}
		</div>
	)
}

function HistoryPanel({
	history,
	onOpen,
	onClear
}: {
	history: ExportHistoryItem[]
	onOpen: (item: ExportHistoryItem) => void
	onClear: () => void
}) {
	return (
		<div className="history-block">
			<div className="section-title">
				<div>
					<History size={15} />
					<span>History</span>
				</div>
				<button
					type="button"
					className="icon-button"
					disabled={history.length === 0}
					title="Clear history"
					aria-label="Clear history"
					onClick={onClear}
				>
					<Trash2 size={15} />
				</button>
			</div>
			{history.length === 0 ? (
				<div className="muted">No exports yet</div>
			) : (
				<div className="history-list">
					{history.map(item => (
						<div className={`history-row ${item.status}`} key={item.id}>
							{item.status === "success" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
							<div>
								<strong title={item.label}>{item.label}</strong>
								<span>
									{item.status} · {formatDuration(item.durationMs)} · {new Date(item.completedAt).toLocaleTimeString()}
								</span>
							</div>
							{item.status === "success" && item.outputRoot && item.outputSegments && (
								<button type="button" className="icon-button" title="Open output folder" aria-label="Open output folder" onClick={() => onOpen(item)}>
									<FolderOpen size={16} />
								</button>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	)
}

export function App() {
	const [mode, setMode] = useState<ToolMode>("container")
	const [baseFiles, setBaseFiles] = useState<PickedFile[]>([])
	const [optionFiles, setOptionFiles] = useState<PickedFile[]>([])
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
	const canRun = !isBusy && Boolean(outputRoot) && selectedJobCount > 0 && !isAnalyzingMerge
	const modeLabel = MODES.find(m => m.mode === mode)!.label.toUpperCase()
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
		if (isOption) {
			setOptionFiles(files)
		} else {
			setBaseFiles(files)
		}
		setResult(null)
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
		setKeyFile(files[0])
		await window.fsdecryptGUI.updateConfig({ keyFilePath: files[0].path })
		if (mergeFiles.length > 0) {
			setIsAnalyzingMerge(true)
			try {
				setMergeGroups(await buildMergeGroups(mergeFiles, byteSourceFromPickedFile(files[0])))
			} catch (error) {
				appendLog(error instanceof Error ? `Could not refresh merge selection: ${error.message}` : "Could not refresh merge selection")
			} finally {
				setIsAnalyzingMerge(false)
			}
		}
		setResult(null)
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

		setMergeFiles(files)
		setMergeGroups([])
		setResult(null)
		if (files.length === 0) return

		setIsAnalyzingMerge(true)
		try {
			setMergeGroups(await buildMergeGroups(files, keySource))
		} catch (error) {
			appendLog(error instanceof Error ? `Could not analyze merge selection: ${error.message}` : "Could not analyze merge selection")
		} finally {
			setIsAnalyzingMerge(false)
		}
	}

	const reset = () => {
		setBaseFiles([])
		setOptionFiles([])
		setMergeFiles([])
		setMergeGroups([])
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

	const extractNtfsSource = async (
		ntfsSource: VhdNtfsSource,
		folderName: string,
		getExtraDetails: () => CompletedResult["details"],
		signal: AbortSignal,
		onBytesWritten: (bytes: number) => void
	): Promise<CompletedResult> => {
		const { extractNtfsContents } = await import("../fsdecrypt/ntfs")
		const outputSegments = outputSegmentsForFolder(outputRoot, folderName)
		if (outputSegments.length > 0) {
			await window.fsdecryptGUI.prepareOutputFolder(outputRoot, outputSegments)
		}
		let totalBytes = 1
		const writer = createFolderWriter(outputRoot, folderName, () => totalBytes, setProgress, signal, onBytesWritten)
		const extracted = await extractNtfsContents(ntfsSource, writer, {
			onLog: appendLog,
			onTotalBytes: bytes => {
				totalBytes = bytes
				setRunStats(current => ({ ...current, totalBytes: bytes }))
			},
			signal
		})
		return {
			outputFolder: sanitizePathSegment(folderName),
			outputSegments,
			outputRoot,
			outputSize: extracted.bytes,
			details: [
				...getExtraDetails(),
				...vhdDetails(ntfsSource),
				{ label: "Files", value: extracted.files.toLocaleString() },
				{ label: "Folders", value: extracted.directories.toLocaleString() }
			]
		}
	}

	const runBaseExport = async (
		file: PickedFile,
		elapsedDetails: () => CompletedResult["details"],
		signal: AbortSignal,
		onBytesWritten: (bytes: number) => void
	) => {
		throwIfAborted(signal)
		const [{ extractInternalVhdSource }, { openVhdChainNtfsSource }] = await Promise.all([
			import("../fsdecrypt/ntfs"),
			import("../fsdecrypt/vhd")
		])
		appendLog(`Opening APP container ${file.name}`)
		const vhdSource = await extractInternalVhdSource(byteSourceFromPickedFile(file), {
			keyFile: keySource,
			onLog: appendLog
		})
		throwIfAborted(signal)
		const ntfsSource = await openVhdChainNtfsSource([vhdSource], { onLog: appendLog })
		return extractNtfsSource(ntfsSource, stripExtension(file.name), elapsedDetails, signal, onBytesWritten)
	}

	const runOptionExport = async (
		file: PickedFile,
		elapsedDetails: () => CompletedResult["details"],
		signal: AbortSignal,
		onBytesWritten: (bytes: number) => void
	) => {
		throwIfAborted(signal)
		const [{ extractExfatContents }, { FSCRYPT_CONTAINER_TYPE, describeContainerType, openFscryptSource }] =
			await Promise.all([import("../fsdecrypt/exfat"), import("../fsdecrypt/fsdecrypt")])
		const exfatSource = await openFscryptSource(byteSourceFromPickedFile(file), {
			expectedContainerType: FSCRYPT_CONTAINER_TYPE.OPTION,
			keyFile: keySource,
			onLog: appendLog
		})
		const folderName = stripExtension(exfatSource.outputFilename)
		const outputSegments = outputSegmentsForFolder(outputRoot, folderName)
		let totalBytes = exfatSource.size
		setRunStats(current => ({ ...current, totalBytes }))
		if (outputSegments.length > 0) {
			await window.fsdecryptGUI.prepareOutputFolder(outputRoot, outputSegments)
		}
		const writer = createFolderWriter(outputRoot, folderName, () => totalBytes, setProgress, signal, onBytesWritten)
		const extracted = await extractExfatContents(exfatSource, writer, {
			onLog: appendLog,
			onTotalBytes: bytes => {
				totalBytes = bytes
				setRunStats(current => ({ ...current, totalBytes: bytes }))
			},
			signal
		})
		return {
			outputFolder: sanitizePathSegment(folderName),
			outputSegments,
			outputRoot,
			outputSize: extracted.bytes,
			details: [
				...elapsedDetails(),
				{ label: "Type", value: describeContainerType(exfatSource.bootId.containerType) },
				{ label: "Game", value: exfatSource.bootId.gameId },
				{ label: "Option", value: exfatSource.bootId.targetOption },
				{ label: "Files", value: extracted.files.toLocaleString() },
				{ label: "Folders", value: extracted.directories.toLocaleString() }
			]
		}
	}

	const runMergeExport = async (
		group: MergeSelectionGroup,
		elapsedDetails: () => CompletedResult["details"],
		signal: AbortSignal,
		onBytesWritten: (bytes: number) => void
	) => {
		throwIfAborted(signal)
		const [{ appContainersToVhdSources }, { openVhdChainNtfsSource }] = await Promise.all([
			import("../fsdecrypt/ntfs"),
			import("../fsdecrypt/vhd")
		])
		const appFiles = group.files.filter(file => file.name.toLowerCase().endsWith(".app"))
		const rawVhdFiles = group.files.filter(file => !file.name.toLowerCase().endsWith(".app"))
		const appVhds =
			appFiles.length > 0
				? await appContainersToVhdSources(appFiles.map(byteSourceFromPickedFile), { keyFile: keySource, onLog: appendLog })
				: []
		throwIfAborted(signal)
		const ntfsSource = await openVhdChainNtfsSource([...rawVhdFiles.map(byteSourceFromPickedFile), ...appVhds], { onLog: appendLog })
		const topName = group.files.length > 0 ? group.files[group.files.length - 1].name : ntfsSource.name
		return extractNtfsSource(ntfsSource, stripExtension(topName), elapsedDetails, signal, onBytesWritten)
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

		const jobs =
			mode === "vhd"
				? mergeGroups.map(group => ({
						label: group.label,
						sources: group.files.map(file => file.name),
						run: () => runMergeExport(group, elapsedDetails, abortController.signal, noteBytesWritten)
					}))
				: selectedContainerFiles.map(file => ({
						label: stripExtension(file.name),
						sources: [file.name],
						run: () =>
							mode === "option"
								? runOptionExport(file, elapsedDetails, abortController.signal, noteBytesWritten)
								: runBaseExport(file, elapsedDetails, abortController.signal, noteBytesWritten)
					}))

		try {
			appendLog(`Starting ${modeLabel} batch with ${jobs.length.toLocaleString()} export(s)`)

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
		} catch (error) {
			console.error(error)
			if (isAbortError(error)) {
				setProgress(0)
				appendLog("Cancelled")
			} else {
				appendLog(error instanceof Error ? `ERROR: ${error.message}` : "ERROR: fsdecrypt failed")
			}
		} finally {
			abortControllerRef.current = null
			setIsBusy(false)
			setActiveJob(null)
		}
	}

	return (
		<div className="app-shell">
			<header className="titlebar">
				<div>
					<h1>fsdecryptGUI</h1>
					<p>Extract APP, Option, and VHD chain contents to a local folder.</p>
				</div>
				<div className="actions">
					<button type="button" className="primary" disabled={!canRun} onClick={run}>
						<Zap size={16} />
						Extract {selectedJobCount > 1 ? selectedJobCount : ""}
					</button>
					{isBusy ? (
						<button type="button" onClick={cancelRun}>
							<X size={16} />
							Cancel
						</button>
					) : (
						<button type="button" onClick={reset}>
							<RotateCcw size={16} />
							Reset
						</button>
					)}
				</div>
			</header>

			<main className="workspace">
				<section className="left-panel">
					<ModeToggle mode={mode} onChange={next => { setMode(next); setResult(null) }} />

					{mode === "vhd" ? (
						<button type="button" className="wide-button" disabled={isBusy} onClick={chooseApps}>
							<HardDriveDownload size={17} />
							Choose Apps
						</button>
					) : (
						<button type="button" className="wide-button" disabled={isBusy} onClick={chooseContainer}>
							<FileArchive size={17} />
							{mode === "option" ? "Choose Updates" : "Choose Games"}
						</button>
					)}
					<button type="button" className="wide-button" disabled={isBusy} onClick={chooseKey}>
						<FileKey size={17} />
						Choose Key
					</button>

					<div className="info-block selected-block">
						<label>Selected</label>
						{mode === "vhd" ? <MergeSelection groups={mergeGroups} isAnalyzing={isAnalyzingMerge} /> : <ContainerSelection files={selectedContainerFiles} />}
						<hr />
						<label>Key</label>
						<strong className="truncate">{keyFile?.name ?? "Built-in"}</strong>
						<hr />
						<label>Output Root</label>
						<div className="path-action-row has-two-actions">
							<strong className="truncate" title={outputRoot || "File > Select Output Folder"}>
								{outputRoot ? basename(outputRoot) : "File > Select Output Folder"}
							</strong>
							<button
								type="button"
								className="icon-button"
								disabled={isBusy}
								title="Select output folder"
								aria-label="Select output folder"
								onClick={selectOutputFolder}
							>
								<FolderPlus size={16} />
							</button>
							<button
								type="button"
								className="icon-button"
								disabled={!outputRoot}
								title="Open output folder"
								aria-label="Open output folder"
								onClick={openOutputRootFolder}
							>
								<FolderOpen size={16} />
							</button>
						</div>
						<hr />
						<label>Config Folder</label>
						<div className="path-action-row">
							<strong className="truncate" title={configFolder || configPath || "config.yaml"}>
								{configFolder ? compactPath(configFolder) : "config.yaml"}
							</strong>
							<button
								type="button"
								className="icon-button"
								disabled={!configFolder}
								title="Open config folder"
								aria-label="Open config folder"
								onClick={openConfigFolder}
							>
								<FolderOpen size={16} />
							</button>
						</div>
					</div>

					<HistoryPanel history={history} onOpen={openHistoryFolder} onClear={clearHistory} />
				</section>

				<section className="main-panel">
					<div className="summary-grid">
						<div>
							<label>Mode</label>
							<strong>{modeLabel}</strong>
						</div>
						<div>
							<label>Jobs</label>
							<strong>{selectedJobCount}</strong>
						</div>
						<div>
							<label>Output</label>
							<div className={result ? "path-action-row" : ""}>
								<strong className={!result ? "muted" : ""}>{result?.outputFolder ?? "Pending"}</strong>
								{result && (
									<button
										type="button"
										className="icon-button"
										title="Open output folder"
										aria-label="Open output folder"
										onClick={openResultFolder}
									>
										<FolderOpen size={16} />
									</button>
								)}
							</div>
						</div>
					</div>

					{(isBusy || progress > 0) && (
						<div className="progress-block">
							<div>
								<span>{activeJob ? `${activeJob.index}/${activeJob.total} ${activeJob.label}` : "Progress"}</span>
								<strong>{progress}%</strong>
							</div>
							<progress value={progress} max={100} />
							<div className="stats-grid">
								<div>
									<label>Elapsed</label>
									<strong>{formatDuration(runStats.elapsedMs)}</strong>
								</div>
								<div>
									<label>Throughput</label>
									<strong>{formatThroughput(runStats.bytesWritten, runStats.elapsedMs)}</strong>
								</div>
								<div>
									<label>ETA</label>
									<strong>{formatEta(runStats)}</strong>
								</div>
							</div>
						</div>
					)}

					{result ? (
						<div className="result-grid">
							{result.details.map(detail => (
								<div key={detail.label}>
									<label>{detail.label}</label>
									<strong>{detail.value}</strong>
								</div>
							))}
							<div>
								<label>Size</label>
								<strong>{formatBytes(result.outputSize)}</strong>
							</div>
						</div>
					) : (
						<div className="empty-state">Ready</div>
					)}
				</section>

				<section className="log-panel">
					<div className="log-title">
						<Terminal size={16} />
						Log
					</div>
					<div className="terminal" ref={terminalRef}>
						{logs.map((line, index) => (
							<div key={`${line}-${index}`}>{line}</div>
						))}
					</div>
				</section>
			</main>
		</div>
	)
}
