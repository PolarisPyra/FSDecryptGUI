import { FileArchive, FileKey, HardDriveDownload } from "lucide-react"

import type { ToolMode } from "./appTypes"

export const MODES: Array<{ mode: ToolMode; label: string; icon: typeof FileArchive }> = [
	{ mode: "container", label: "Base", icon: FileArchive },
	{ mode: "option", label: "Option", icon: FileKey },
	{ mode: "vhd", label: "Merge", icon: HardDriveDownload }
]
