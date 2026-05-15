import { BrowserWindow, Menu, app, session } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"

type ChromeActions = {
	chooseInputFolder: (window: BrowserWindow, notifyRenderer?: boolean) => Promise<unknown>
	chooseOutputFolder: (window: BrowserWindow) => Promise<unknown>
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
const devServerUrl = process.env.VITE_DEV_SERVER_URL ? new URL(process.env.VITE_DEV_SERVER_URL) : undefined

function resolveRendererPath() {
	return path.join(__dirname, "../dist/index.html")
}

/**
 * Resolves the preload script for both watched TypeScript builds and packaged output.
 *
 * @returns Absolute path to the CommonJS preload bridge Electron can load.
 */
function resolvePreloadPath() {
	return isDev ? path.join(__dirname, "../src/electron/preload.cjs") : path.join(__dirname, "preload.cjs")
}

/**
 * Finds the window that should own dialogs and menu actions.
 *
 * @returns The focused window, or the first app window when focus has moved away.
 */
export function focusedWindow() {
	return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

/**
 * Installs the desktop menu and wires File actions to the main-process adapters.
 *
 * @param actions Folder-picking operations that may also notify the renderer.
 */
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

function allowedAppUrl(url: string) {
	try {
		const parsed = new URL(url)
		if (parsed.protocol === "file:") {
			return true
		}

		if (isDev && devServerUrl && parsed.origin === devServerUrl.origin) {
			return true
		}
	} catch {
		return false
	}

	return false
}

/**
 * Applies Electron security controls that are global to the app session.
 *
 * The renderer is local-only, so navigation, popups, and runtime permissions are
 * denied by default. CSP is injected here instead of a meta tag so it also covers
 * packaged `file://` loads and dev-server responses.
 */
export function installSecurityHandlers() {
	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
		const connectSrc = isDev && devServerUrl ? `'self' ${devServerUrl.origin} ws://${devServerUrl.host}` : "'self'"
		callback({
			responseHeaders: {
				...details.responseHeaders,
				"Content-Security-Policy": [
					[
						"default-src 'self'",
						"script-src 'self'",
						"style-src 'self' 'unsafe-inline'",
						"img-src 'self' data:",
						"font-src 'self' data:",
						`connect-src ${connectSrc}`,
						"object-src 'none'",
						"base-uri 'self'",
						"frame-src 'none'"
					].join("; ")
				]
			}
		})
	})

	session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
		callback(false)
	})

	app.on("web-contents-created", (_event, contents) => {
		contents.on("will-navigate", (event, navigationUrl) => {
			if (!allowedAppUrl(navigationUrl)) {
				event.preventDefault()
			}
		})

		contents.setWindowOpenHandler(() => ({ action: "deny" }))
	})
}

/**
 * Creates the single fsdecryptGUI BrowserWindow with hardened webPreferences.
 *
 * @returns A promise that resolves after the renderer has loaded.
 */
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
			sandbox: true,
			nodeIntegration: false,
			webviewTag: false,
			allowRunningInsecureContent: false,
			experimentalFeatures: false,
			preload: resolvePreloadPath()
		}
	})

	if (isDev && process.env.VITE_DEV_SERVER_URL) {
		await window.loadURL(process.env.VITE_DEV_SERVER_URL)
	} else {
		await window.loadFile(resolveRendererPath())
	}
}
