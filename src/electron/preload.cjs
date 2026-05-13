const { contextBridge, ipcRenderer } = require("electron")

const api = {
	pickFiles: options => ipcRenderer.invoke("dialog:pickFiles", options),
	readConfig: () => ipcRenderer.invoke("config:read"),
	updateConfig: patch => ipcRenderer.invoke("config:update", patch),
	openConfigFolder: () => ipcRenderer.invoke("config:openFolder"),
	onConfigChanged: callback => {
		const listener = (_event, config) => callback(config)
		ipcRenderer.on("config:changed", listener)
		return () => ipcRenderer.removeListener("config:changed", listener)
	},
	readRange: (filePath, offset, length) => ipcRenderer.invoke("fs:readRange", filePath, offset, length),
	ensureDirectory: (rootPath, segments) => ipcRenderer.invoke("fs:ensureDirectory", rootPath, segments),
	writeFileChunk: (rootPath, segments, chunk, append) =>
		ipcRenderer.invoke("fs:writeFileChunk", {
			rootPath,
			segments,
			chunk: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
			append
		})
}

contextBridge.exposeInMainWorld("fsdecryptGUI", api)
