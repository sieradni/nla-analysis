/*
 * The few shell actions that cross a module boundary.
 *
 * `app.js` owns navigation and the open-tab lifecycle; the render modules call through this object
 * so they do not import the shell back. It is assigned once, before `boot`.
 */
export const actions = {
  openProject: null,
  openView: null,
  afterOpen: null,
  openTabDialog: null,
  openProjectDialog: null,
  renderEntry: null,
  selectPoint: null,
  setStatus: null,
}
