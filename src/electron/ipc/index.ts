import { registerAppHandlers } from "./appHandlers.js"
import { registerConfigHandlers } from "./configHandlers.js"
import { registerDialogHandlers } from "./dialogHandlers.js"
import { registerFileSystemHandlers } from "./fileSystemHandlers.js"

/** Registers every IPC domain while keeping main.ts focused on app lifecycle. */
export function registerIpcHandlers() {
	registerDialogHandlers()
	registerConfigHandlers()
	registerAppHandlers()
	registerFileSystemHandlers()
}
