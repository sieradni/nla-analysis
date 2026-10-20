/**
 * The window's project session: one open `Workspace`, reused across calls.
 *
 * The view cache is deliberately not here. `view-session.ts` owns what the window is holding and
 * what still has to be saved; this module only answers "which project is open".
 */
import { Workspace } from '../src/core/workspace.ts'

let session: Workspace | null = null

export function useWorkspace(workspace: Workspace): void {
  session = workspace
}

/**
 * The session's workspace for `dir`, opening it if this is the first call or a different project.
 * A subdirectory is fine: `Workspace.open` walks up to the project root, and the comparison is
 * against the root it found.
 */
export async function workspaceFor(dir: string): Promise<Workspace> {
  if (session && session.dir === dir) return session
  session = await Workspace.open(dir)
  return session
}
