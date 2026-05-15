import type { RefObject } from "react"

import {
	AlertTriangle,
	ArrowRightLeft,
	CheckCircle2,
	CircleDot,
	Clipboard,
	FileArchive,
	FileKey,
	FolderOpen,
	FolderPlus,
	HardDriveDownload,
	History,
	Info,
	ListTree,
	Link2,
	Moon,
	RotateCcw,
	Save,
	Sun,
	Terminal,
	Trash2,
	X,
	Zap
} from "lucide-react"

import { formatBytes, formatDuration, formatEta, formatThroughput } from "../../base/common/format"
import { basename, compactPath } from "../../base/common/path"
import type { PickedFile } from "../../electron-api"
import { MODES } from "../common/modes"
import type {
	ActiveJob,
	AppScreen,
	BaseSelectionGroup,
	CompletedResult,
	ExportHistoryItem,
	KeyValidation,
	MergeSelectionGroup,
	OptionSelectionGroup,
	RunStats,
	ThemeMode,
	ToolMode
} from "../common/appTypes"
import { IcfView } from "./icfView"
import type { SelectionQueues } from "../services/selectionQueue"

function chainLayerClass(state: "linked" | "missing" | "standalone") {
	return state === "standalone" ? "chain-layer" : `chain-layer ${state}`
}

function ChainLayerIcon({ state, role }: { state: "linked" | "missing" | "standalone"; role: string }) {
	if (state === "missing") return <AlertTriangle size={14} />
	if (state === "linked" && role !== "standalone") return <Link2 size={14} />
	if (role === "raw") return <HardDriveDownload size={14} />
	return <CircleDot size={14} />
}

function ModeToggle({ mode, onChange }: { mode: ToolMode; onChange: (mode: ToolMode) => void }) {
	const activeIndex = MODES.findIndex(item => item.mode === mode)
	return (
		<div className="mode-toggle" style={{ "--active-index": activeIndex } as React.CSSProperties}>
			<div className="mode-indicator" />
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

function ScreenToggle({ screen, onChange }: { screen: AppScreen; onChange: (screen: AppScreen) => void }) {
	const activeIndex = screen === "extract" ? 0 : 1
	return (
		<div className="screen-toggle" style={{ "--active-index": activeIndex } as React.CSSProperties}>
			<div className="screen-indicator" />
			<button type="button" className={screen === "extract" ? "active" : ""} onClick={() => onChange("extract")}>
				<HardDriveDownload size={15} />
				<span>Extract</span>
			</button>
			<button type="button" className={screen === "icf" ? "active" : ""} onClick={() => onChange("icf")}>
				<ListTree size={15} />
				<span>ICF</span>
			</button>
		</div>
	)
}

function MergeSelection({
	groups,
	isAnalyzing,
	onRemoveFile,
	onToggleGroup,
	onMoveToMerge
}: {
	groups: Array<MergeSelectionGroup | BaseSelectionGroup>
	isAnalyzing: boolean
	onRemoveFile: (path: string) => void
	onToggleGroup: (id: string, selected: boolean) => void
	onMoveToMerge?: (group: BaseSelectionGroup) => void
}) {
	if (isAnalyzing) {
		return <div className="muted">Reading APP chain metadata...</div>
	}

	if (groups.length === 0) {
		return <div className="muted">None</div>
	}

	return (
		<div className="selected-list">
			{groups.map((group, index) => (
				<div className={`chain-card ${group.selected ? "" : "excluded"}`} key={group.id || index}>
					<div className="chain-card-header">
						<div className="chain-select">
							<input
								type="checkbox"
								checked={group.selected}
								aria-label={`${group.selected ? "Exclude" : "Include"} ${group.label}`}
								onChange={event => onToggleGroup(group.id, event.currentTarget.checked)}
							/>
						</div>
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
					{group.notice && (
						<div className="chain-notice">
							<Info size={14} />
							<span>{group.notice}</span>
						</div>
					)}
					{onMoveToMerge && (("hasChildLayer" in group && group.hasChildLayer) || group.rawVhds.length > 0) && (
						<button type="button" className="move-selection-button" onClick={() => onMoveToMerge(group as BaseSelectionGroup)}>
							<ArrowRightLeft size={14} />
							Move to Merge
						</button>
					)}
					<div className="chain-layers">
						{group.appLayers.map(layer => (
							<div className={chainLayerClass(layer.display.state)} key={layer.file.path}>
								<ChainLayerIcon state={layer.display.state} role={layer.display.role} />
								<div>
									<strong title={layer.file.name}>{layer.file.name}</strong>
									<span>{layer.display.detail}</span>
								</div>
								<button
									type="button"
									className="remove-selection-button"
									title={`Remove ${layer.file.name}`}
									aria-label={`Remove ${layer.file.name}`}
									onClick={() => onRemoveFile(layer.file.path)}
								>
									<X size={14} />
								</button>
							</div>
						))}
						{group.rawVhds.map(file => (
							<div className="chain-layer linked" key={file.path}>
								<ChainLayerIcon state="linked" role="raw" />
								<div>
									<strong title={file.name}>{file.name}</strong>
									<span>{formatBytes(file.size)}</span>
								</div>
								<button
									type="button"
									className="remove-selection-button"
									title={`Remove ${file.name}`}
									aria-label={`Remove ${file.name}`}
									onClick={() => onRemoveFile(file.path)}
								>
									<X size={14} />
								</button>
							</div>
						))}
					</div>
				</div>
			))}
		</div>
	)
}

function OptionSelection({
	groups,
	isAnalyzing,
	onRemoveFile,
	onToggleGroup
}: {
	groups: OptionSelectionGroup[]
	isAnalyzing: boolean
	onRemoveFile: (path: string) => void
	onToggleGroup: (id: string, selected: boolean) => void
}) {
	if (isAnalyzing) {
		return <div className="muted">Reading OPTION VHD metadata...</div>
	}

	if (groups.length === 0) {
		return <div className="muted">None</div>
	}

	return (
		<div className="selected-list">
			{groups.map((group, index) => (
				<div className={`chain-card ${group.selected ? "" : "excluded"}`} key={group.id || index}>
					<div className="chain-card-header">
						<div className="chain-select">
							<input
								type="checkbox"
								checked={group.selected}
								aria-label={`${group.selected ? "Exclude" : "Include"} ${group.label}`}
								onChange={event => onToggleGroup(group.id, event.currentTarget.checked)}
							/>
						</div>
						<div>
							<label>OPTION VHD Chain</label>
							<strong title={group.label}>{group.label}</strong>
						</div>
						<span>{group.files.length} update{group.files.length === 1 ? "" : "s"}</span>
					</div>
					{group.warning && (
						<div className="chain-warning">
							<AlertTriangle size={14} />
							<span>{group.warning}</span>
						</div>
					)}
					{group.notice && (
						<div className="chain-notice">
							<Info size={14} />
							<span>{group.notice}</span>
						</div>
					)}
					<div className="chain-layers">
						{group.optionLayers.map(layer => (
							<div className={chainLayerClass(layer.display.state)} key={layer.file.path}>
								<ChainLayerIcon state={layer.display.state} role={layer.display.role} />
								<div>
									<strong title={layer.file.name}>{layer.file.name}</strong>
									<span>{layer.display.detail}</span>
								</div>
								<button
									type="button"
									className="remove-selection-button"
									title={`Remove ${layer.file.name}`}
									aria-label={`Remove ${layer.file.name}`}
									onClick={() => onRemoveFile(layer.file.path)}
								>
									<X size={14} />
								</button>
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

export type AppViewProps = {
	screen: AppScreen
	mode: ToolMode
	theme: ThemeMode
	modeLabel: string
	isBusy: boolean
	canRun: boolean
	runButtonLabel: string
	runAllModes: boolean
	hasMultipleModeJobs: boolean
	onRunAllModesChange: (enabled: boolean) => void
	selectedJobCount: number
	baseGroups: BaseSelectionGroup[]
	optionGroups: OptionSelectionGroup[]
	mergeGroups: MergeSelectionGroup[]
	isAnalyzingBase: boolean
	isAnalyzingOptions: boolean
	isAnalyzingMerge: boolean
	keyFile: PickedFile | null
	keyValidation: KeyValidation
	outputRoot: string
	inputRoot: string
	configPath: string
	configFolder: string
	history: ExportHistoryItem[]
	result: CompletedResult | null
	progress: number
	runStats: RunStats
	activeJob: ActiveJob | null
	logs: string[]
	queues: SelectionQueues
	terminalRef: RefObject<HTMLDivElement | null>
	onScreenChange: (screen: AppScreen) => void
	onToggleGroupSelected: (mode: ToolMode, groupId: string, selected: boolean) => void
	onSetModeGroupsSelected: (mode: ToolMode, selected: boolean) => void
	onModeChange: (mode: ToolMode) => void
	onToggleTheme: () => void
	onRun: () => void
	onCancelRun: () => void
	onReset: () => void
	onChooseApps: () => void
	onChooseContainer: () => void
	onChooseKey: () => void
	onSelectInputFolder: () => void
	onClearKey: () => void
	onRemoveBaseFile: (path: string) => void
	onRemoveOptionFile: (path: string) => void
	onRemoveMergeFile: (path: string) => void
	onMoveBaseGroupToMerge: (group: BaseSelectionGroup) => void
	onSelectOutputFolder: () => void
	onOpenOutputRootFolder: () => void
	onOpenConfigFolder: () => void
	onOpenResultFolder: () => void
	onOpenHistoryFolder: (item: ExportHistoryItem) => void
	onClearHistory: () => void
	onCopyLogs: () => void
	onSaveLogs: () => void
}

export function AppView(props: AppViewProps) {
	const ThemeIcon = props.theme === "dark" ? Sun : Moon
	const nextTheme = props.theme === "dark" ? "light" : "dark"
	const currentSelectionGroups =
		props.mode === "vhd" ? props.mergeGroups : props.mode === "option" ? props.optionGroups : props.baseGroups
	const allCurrentGroupsSelected = currentSelectionGroups.length > 0 && currentSelectionGroups.every(group => group.selected)
	const checkedCurrentGroupCount = currentSelectionGroups.filter(group => group.selected).length
	return (
		<div className="app-shell">
			<header className="titlebar">
				<div className="titlebar-heading">
					<div>
						<h1>fsdecryptGUI</h1>
						<p>Extract containers and manage ICF metadata from the same workspace.</p>
					</div>
					<ScreenToggle screen={props.screen} onChange={props.onScreenChange} />
				</div>
				<div className="actions">
					<div className={`run-actions ${props.screen === "extract" ? "" : "layout-placeholder"}`} aria-hidden={props.screen !== "extract"}>
						{props.hasMultipleModeJobs && (
							<label className={`run-all-toggle ${props.runAllModes ? "active" : ""} ${props.isBusy ? "disabled" : ""}`}>
								<input
									type="checkbox"
									checked={props.runAllModes}
									disabled={props.isBusy || props.screen !== "extract"}
									onChange={event => props.onRunAllModesChange(event.currentTarget.checked)}
								/>
								<span className="run-all-switch" aria-hidden="true" />
								<span>All</span>
							</label>
						)}
						<button type="button" className="primary" disabled={!props.canRun || props.screen !== "extract"} onClick={props.onRun}>
							<Zap size={16} />
							{props.runButtonLabel}
						</button>
					</div>
					<div className={`utility-actions ${props.screen === "extract" ? "" : "layout-placeholder"}`} aria-hidden={props.screen !== "extract"}>
						{props.isBusy ? (
							<button type="button" disabled={props.screen !== "extract"} onClick={props.onCancelRun}>
								<X size={16} />
								Cancel
							</button>
						) : (
							<button type="button" disabled={props.screen !== "extract"} onClick={props.onReset}>
								<RotateCcw size={16} />
								Reset
							</button>
						)}
					</div>
					<div className="utility-actions">
						<button
							type="button"
							className="icon-button theme-toggle"
							title={`Switch to ${nextTheme} theme`}
							aria-label={`Switch to ${nextTheme} theme`}
							aria-pressed={props.theme === "light"}
							onClick={props.onToggleTheme}
						>
							<ThemeIcon size={16} />
						</button>
					</div>
				</div>
			</header>

			{props.screen === "icf" ? (
				<IcfView queues={props.queues} isBusy={props.isBusy} />
			) : (
			<main className="workspace">
				<section className="left-panel">
					<ModeToggle mode={props.mode} onChange={props.onModeChange} />

					{props.mode === "vhd" ? (
						<button type="button" className="wide-button" disabled={props.isBusy} onClick={props.onChooseApps}>
							<HardDriveDownload size={17} />
							Choose Apps
						</button>
					) : (
						<button type="button" className="wide-button" disabled={props.isBusy} onClick={props.onChooseContainer}>
							<FileArchive size={17} />
							{props.mode === "option" ? "Choose Updates" : "Choose Games"}
						</button>
					)}
					<button type="button" className="wide-button" disabled={props.isBusy} onClick={props.onChooseKey}>
						<FileKey size={17} />
						Choose Key
					</button>

					<div className="info-block selected-block">
						<div className="selected-heading">
							<label>Selected</label>
							<label className="select-all-toggle">
								<input
									type="checkbox"
									checked={allCurrentGroupsSelected}
									disabled={props.isBusy || currentSelectionGroups.length === 0}
									onChange={event => props.onSetModeGroupsSelected(props.mode, event.currentTarget.checked)}
								/>
								<span>
									All {checkedCurrentGroupCount}/{currentSelectionGroups.length}
								</span>
							</label>
						</div>
						{props.mode === "vhd" ? (
							<MergeSelection
								groups={props.mergeGroups}
								isAnalyzing={props.isAnalyzingMerge}
								onRemoveFile={props.onRemoveMergeFile}
								onToggleGroup={(id, selected) => props.onToggleGroupSelected("vhd", id, selected)}
							/>
						) : props.mode === "option" ? (
							<OptionSelection
								groups={props.optionGroups}
								isAnalyzing={props.isAnalyzingOptions}
								onRemoveFile={props.onRemoveOptionFile}
								onToggleGroup={(id, selected) => props.onToggleGroupSelected("option", id, selected)}
							/>
						) : (
							<MergeSelection
								groups={props.baseGroups}
								isAnalyzing={props.isAnalyzingBase}
								onRemoveFile={props.onRemoveBaseFile}
								onToggleGroup={(id, selected) => props.onToggleGroupSelected("container", id, selected)}
								onMoveToMerge={props.onMoveBaseGroupToMerge}
							/>
						)}
						<hr />
						<label>Key</label>
						<div className={`key-status ${props.keyValidation.status}`}>
							{props.keyValidation.status === "invalid" ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
							<div>
								<div className="key-heading">
									<strong className="truncate" title={props.keyFile?.path ?? props.keyValidation.label}>{props.keyFile?.name ?? props.keyValidation.label}</strong>
									<span>{props.keyValidation.label}</span>
								</div>
								<span>{props.keyValidation.detail}</span>
							</div>
							{props.keyFile && (
								<button type="button" className="icon-button" disabled={props.isBusy} title="Clear key" aria-label="Clear key" onClick={props.onClearKey}>
									<X size={15} />
								</button>
							)}
						</div>
						<hr />
						<label>Input Folder</label>
						<div className="path-action-row">
							<strong className="truncate" title={props.inputRoot || "Select a folder containing APP, OPT, and VHD files"}>
								{props.inputRoot ? basename(props.inputRoot) : "Select Input Folder"}
							</strong>
							<button
								type="button"
								className="icon-button"
								disabled={props.isBusy}
								title="Select input folder"
								aria-label="Select input folder"
								onClick={props.onSelectInputFolder}
							>
								<FolderPlus size={16} />
							</button>
						</div>
						<hr />
						<label>Output Folder</label>
						<div className="path-action-row has-two-actions">
							<strong className="truncate" title={props.outputRoot || "File > Select Output Folder"}>
								{props.outputRoot ? basename(props.outputRoot) : "File > Select Output Folder"}
							</strong>
							<button
								type="button"
								className="icon-button"
								disabled={props.isBusy}
								title="Select output folder"
								aria-label="Select output folder"
								onClick={props.onSelectOutputFolder}
							>
								<FolderPlus size={16} />
							</button>
							<button
								type="button"
								className="icon-button"
								disabled={!props.outputRoot}
								title="Open output folder"
								aria-label="Open output folder"
								onClick={props.onOpenOutputRootFolder}
							>
								<FolderOpen size={16} />
							</button>
						</div>
						<hr />
						<label>Config Folder</label>
						<div className="path-action-row">
							<strong className="truncate" title={props.configFolder || props.configPath || "config.yaml"}>
								{props.configFolder ? compactPath(props.configFolder) : "config.yaml"}
							</strong>
							<button
								type="button"
								className="icon-button"
								disabled={!props.configFolder}
								title="Open config folder"
								aria-label="Open config folder"
								onClick={props.onOpenConfigFolder}
							>
								<FolderOpen size={16} />
							</button>
						</div>
					</div>

					<HistoryPanel history={props.history} onOpen={props.onOpenHistoryFolder} onClear={props.onClearHistory} />
				</section>

				<section className="main-panel">
					<div className="summary-grid">
						<div>
							<label>Mode</label>
							<strong>{props.modeLabel}</strong>
						</div>
						<div>
							<label>Jobs</label>
							<strong>{props.selectedJobCount}</strong>
						</div>
						<div>
							<label>Output</label>
							<div className={props.result ? "path-action-row" : ""}>
								<strong className={!props.result ? "muted" : ""}>{props.result?.outputFolder ?? "Pending"}</strong>
								{props.result && (
									<button
										type="button"
										className="icon-button"
										title="Open output folder"
										aria-label="Open output folder"
										onClick={props.onOpenResultFolder}
									>
										<FolderOpen size={16} />
									</button>
								)}
							</div>
						</div>
					</div>

					{(props.isBusy || props.progress > 0) && (
						<div className="progress-block">
							<div>
								<span>{props.activeJob ? `${props.activeJob.index}/${props.activeJob.total} ${props.activeJob.label}` : "Progress"}</span>
								<strong>{props.progress}%</strong>
							</div>
							<progress value={props.progress} max={100} />
							<div className="stats-grid">
								<div>
									<label>Elapsed</label>
									<strong>{formatDuration(props.runStats.elapsedMs)}</strong>
								</div>
								<div>
									<label>Throughput</label>
									<strong>{formatThroughput(props.runStats.bytesWritten, props.runStats.elapsedMs)}</strong>
								</div>
								<div>
									<label>ETA</label>
									<strong>{formatEta(props.runStats)}</strong>
								</div>
							</div>
						</div>
					)}

					{props.result ? (
						<div className="result-grid">
							{props.result.details.map(detail => (
								<div key={detail.label}>
									<label>{detail.label}</label>
									<strong>{detail.value}</strong>
								</div>
							))}
							<div>
								<label>Size</label>
								<strong>{formatBytes(props.result.outputSize)}</strong>
							</div>
						</div>
					) : (
						<div className="empty-state">Ready</div>
					)}
				</section>

				<section className="log-panel">
					<div className="log-title">
						<div className="log-title-label">
							<Terminal size={16} />
							Log
						</div>
						<div className="log-actions">
							<button type="button" className="icon-button" disabled={props.logs.length === 0} title="Copy log" aria-label="Copy log" onClick={props.onCopyLogs}>
								<Clipboard size={15} />
							</button>
							<button type="button" className="icon-button" disabled={props.logs.length === 0} title="Save log" aria-label="Save log" onClick={props.onSaveLogs}>
								<Save size={15} />
							</button>
						</div>
					</div>
					<div className="terminal" ref={props.terminalRef}>
						{props.logs.map((line, index) => (
							<div key={`${line}-${index}`}>{line}</div>
						))}
					</div>
				</section>
			</main>
			)}
		</div>
	)
}
