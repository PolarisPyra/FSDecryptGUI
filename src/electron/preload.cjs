const { contextBridge, ipcRenderer } = require("electron")

const api = {
	pickFiles: options => ipcRenderer.invoke("dialog:pickFiles", options),
	selectOutputFolder: () => ipcRenderer.invoke("dialog:selectOutputFolder"),
	readConfig: () => ipcRenderer.invoke("config:read"),
	updateConfig: patch => ipcRenderer.invoke("config:update", patch),
	openConfigFolder: () => ipcRenderer.invoke("config:openFolder"),
	onConfigChanged: callback => {
		const listener = (_event, config) => callback(config)
		ipcRenderer.on("config:changed", listener)
		return () => ipcRenderer.removeListener("config:changed", listener)
	},
	readRange: (filePath, offset, length) => ipcRenderer.invoke("fs:readRange", filePath, offset, length),
	decryptFscryptRange: request => ipcRenderer.invoke("fs:decryptFscryptRange", request),
	ensureDirectory: (rootPath, segments) => ipcRenderer.invoke("fs:ensureDirectory", rootPath, segments),
	prepareOutputFolder: (rootPath, segments) => ipcRenderer.invoke("fs:prepareOutputFolder", { rootPath, segments }),
	openOutputFolder: (rootPath, segments) => ipcRenderer.invoke("fs:openOutputFolder", { rootPath, segments }),
	writeFileChunk: (rootPath, segments, chunk, append) =>
		ipcRenderer.invoke("fs:writeFileChunk", {
			rootPath,
			segments,
			chunk: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
			append
		}),
	closeOutputFile: (rootPath, segments) => ipcRenderer.invoke("fs:closeOutputFile", { rootPath, segments }),
	removeOutputPath: (rootPath, segments) => ipcRenderer.invoke("fs:removeOutputPath", { rootPath, segments })
}

contextBridge.exposeInMainWorld("fsdecryptGUI", api)
