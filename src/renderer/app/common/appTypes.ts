import type { ReadableByteSource } from "../../../fsdecrypt/byte-source"
import type { FscryptBootId } from "../../../fsdecrypt/fsdecrypt"
import type { VhdLayerInfo } from "../../../fsdecrypt/vhd"
import type { PickedFile } from "../../electron-api"

export type ToolMode = "container" | "option" | "vhd"
export type HistoryStatus = "success" | "failed" | "cancelled"

export type CompletedResult = {
	outputFolder: string
	outputSegments: string[]
	outputRoot: string
	outputSize: number
	details: Array<{ label: string; value: string }>
}

export type RunStats = {
	elapsedMs: number
	bytesWritten: number
	totalBytes: number
}

export type KeyValidation = {
	status: "builtin" | "valid" | "invalid"
	label: string
	detail: string
	error?: string
}

export type ActiveJob = {
	index: number
	total: number
	label: string
}

export type OptionVhdSource = ReadableByteSource & {
	optionGameId?: string
	optionSequenceNumber?: number
}

export type OptionVhdLayerInfo = VhdLayerInfo & {
	optionFilePath: string
	optionFileName: string
	sourceOptionName: string
}

export type OptionLayerInfo = {
	file: PickedFile
	bootId?: FscryptBootId
	error?: string
	vhdLayers: OptionVhdLayerInfo[]
}

export type OptionSelectionGroup = {
	id: string
	label: string
	files: PickedFile[]
	optionLayers: OptionLayerInfo[]
	warning?: string
	notice?: string
}

export type VersionLike = {
	major: number
	minor: number
	release: number
}

export type AppLayerInfo = {
	file: PickedFile
	bootId?: FscryptBootId
	error?: string
	parentFile?: PickedFile
	childFile?: PickedFile
}

export type MergeSelectionGroup = {
	id: string
	label: string
	files: PickedFile[]
	appLayers: AppLayerInfo[]
	rawVhds: PickedFile[]
	warning?: string
	notice?: string
}

export type BaseSelectionGroup = MergeSelectionGroup & {
	hasChildLayer: boolean
}

export type ExportHistoryItem = {
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
