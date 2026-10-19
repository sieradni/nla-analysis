/**
 * The only bridge between the window and the core.
 *
 * The renderer gets a handful of async calls and nothing else: no filesystem, no child processes, no
 * Node globals. Every call lands on the core in the main process, so the UI cannot invent a second
 * way to read a project.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bench', {
  projects: () => ipcRenderer.invoke('bench:projects'),
  startup: () => ipcRenderer.invoke('bench:startup'),
  openProject: (dir) => ipcRenderer.invoke('bench:openProject', dir),
  views: (dir) => ipcRenderer.invoke('bench:views', dir),
  view: (dir, name) => ipcRenderer.invoke('bench:view', dir, name),
  pickProject: () => ipcRenderer.invoke('bench:pickProject'),
  ready: () => ipcRenderer.send('bench:ready'),
})
