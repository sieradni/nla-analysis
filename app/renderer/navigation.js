/*
 * The few shell actions that cross a module boundary.
 *
 * `app.js` owns navigation and the open-tab lifecycle; the render modules call through this object
 * so they do not import a module above them back. It is assigned once, before `boot`.
 */
export const actions = {
  openProject: null,
  openView: null,
  afterOpen: null,
  openTabDialog: null,
  openProjectDialog: null,
  renderEntry: null,
  selectPoint: null,
  pointAction: null,
  setStatus: null,
  // A tab's own menu: the rail draws the button, the open-tab lifecycle owns the popover and the
  // acts behind it, so the rail never learns how to close or rename anything.
  tabMenu: null,
  // The name sheet Rename and Duplicate share. `tabs.js` owns the sheet; the acts it asks for are
  // `tab-actions.js`'s, reached through these entries rather than by importing each other.
  openNameSheet: null,
  closeTab: null,
  // The two directions of the fifth kind of act. `acts.js` calls them by kind, because the table
  // that names every act is the one place a kind becomes a button.
  undoTabCreated: null,
  redoTabCreated: null,
  // What the act table would do next in a direction. The bar's undo button and the status's redo
  // button both show it, and `acts.js` — which owns that table — sits above both of them.
  actOffer: null,
}
