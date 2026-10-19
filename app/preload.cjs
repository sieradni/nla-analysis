/**
 * The only bridge between the window and the core.
 *
 * The renderer gets a handful of async calls and nothing else: no filesystem, no child processes, no
 * Node globals. Every call lands on the core in the main process, so the UI cannot invent a second
 * way to read a project.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bench', {
  // reading
  projects: () => ipcRenderer.invoke('bench:projects'),
  startup: () => ipcRenderer.invoke('bench:startup'),
  openProject: (dir) => ipcRenderer.invoke('bench:openProject', dir),
  views: (dir) => ipcRenderer.invoke('bench:views', dir),
  view: (dir, name) => ipcRenderer.invoke('bench:view', dir, name),
  pickProject: () => ipcRenderer.invoke('bench:pickProject'),
  // writing: append one point, retract one point, rebuild a tab from the current data. Nothing that
  // takes a log event, a file path or a raw command, so the window cannot write anything else.
  recordPoint: (dir, draft, viewName) => ipcRenderer.invoke('bench:recordPoint', dir, draft, viewName),
  retractPoint: (dir, id, reason) => ipcRenderer.invoke('bench:retractPoint', dir, id, reason),
  refreshView: (dir, name, options) => ipcRenderer.invoke('bench:refreshView', dir, name, options),
  ready: () => ipcRenderer.send('bench:ready'),
})
