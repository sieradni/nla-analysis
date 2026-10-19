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
  point: (dir, id, viewName) => ipcRenderer.invoke('bench:point', dir, id, viewName),
  recipes: () => ipcRenderer.invoke('bench:recipes'),
  shapeChoice: () => ipcRenderer.invoke('bench:shapeChoice'),
  pickFolder: () => ipcRenderer.invoke('bench:pickFolder'),
  // writing
  writeView: (dir, draft) => ipcRenderer.invoke('bench:writeView', dir, draft),
  createProject: (parent, name, shape) =>
    ipcRenderer.invoke('bench:createProject', parent, name, shape),
  // Writing: append one point, correct one point, retract one point, write a tab, rebuild a tab from
  // the current data. Nothing that takes a log event, a file path or a raw command, so the window
  // cannot write anything else.
  recordPoint: (dir, draft, viewName) => ipcRenderer.invoke('bench:recordPoint', dir, draft, viewName),
  correctPoint: (dir, id, values, viewName) =>
    ipcRenderer.invoke('bench:correctPoint', dir, id, values, viewName),
  retractPoint: (dir, id, reason) => ipcRenderer.invoke('bench:retractPoint', dir, id, reason),
  refreshView: (dir, name, options) => ipcRenderer.invoke('bench:refreshView', dir, name, options),
  // live updates: the window says which tab it is drawing, and the main process watches the project
  // for that tab. `onChanged` is a push, not a call — the renderer never polls the disk.
  watch: (dir, name) => ipcRenderer.invoke('bench:watch', dir, name),
  onChanged: (callback) => ipcRenderer.on('bench:changed', (_event, change) => callback(change)),
  ready: () => ipcRenderer.send('bench:ready'),
})
