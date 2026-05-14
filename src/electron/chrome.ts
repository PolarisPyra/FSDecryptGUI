import { BrowserWindow, Menu } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"

type ChromeActions = {
	chooseInputFolder: (window: BrowserWindow, notifyRenderer?: boolean) => Promise<unknown>
	chooseOutputFolder: (window: BrowserWindow) => Promise<unknown>
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)

function resolveRendererPath() {
	return path.join(__dirname, "../dist/index.html")
}

function resolvePreloadPath() {
	return isDev ? path.join(__dirname, "../src/electron/preload.cjs") : path.join(__dirname, "preload.cjs")
}

export function focusedWindow() {
	return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

export function installMenu(actions: ChromeActions) {
	const template: MenuItemConstructorOptions[] = [
		{
			label: "File",
			submenu: [
				{
					label: "Select Input Folder...",
					accelerator: "CmdOrCtrl+I",
					click: () => {
						const window = focusedWindow()
						if (window) {
							void actions.chooseInputFolder(window, true)
						}
					}
				},
				{
					label: "Select Output Folder...",
					accelerator: "CmdOrCtrl+O",
					click: () => {
						const window = focusedWindow()
						if (window) {
							void actions.chooseOutputFolder(window)
						}
					}
				},
				{ type: "separator" },
				process.platform === "darwin" ? { role: "close" } : { role: "quit" }
			]
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" }
			]
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" }
			]
		},
		{
			label: "Window",
			submenu: [{ role: "minimize" }, { role: "close" }]
		}
	]

	Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

export async function createWindow() {
	const window = new BrowserWindow({
		width: 1480,
		height: 960,
		minWidth: 1100,
		minHeight: 720,
		title: "fsdecryptGUI",
		backgroundColor: "#101418",
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: resolvePreloadPath()
		}
	})

	if (isDev && process.env.VITE_DEV_SERVER_URL) {
		await window.loadURL(process.env.VITE_DEV_SERVER_URL)
	} else {
		await window.loadFile(resolveRendererPath())
	}
}
