import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The desktop shell does not import `src/core`; it imports the bundle that `pnpm app:build` produces,
 * because Electron's Node cannot strip TypeScript types. That makes the bundle an interface, and an
 * interface that is only tested by launching an app is an interface that breaks silently.
 *
 * `pnpm verify` builds it first, so these assertions run on every green check. When the file is
 * absent (someone ran `vitest` directly), the suite skips rather than failing for the wrong reason.
 */
const bundlePath = join(process.cwd(), 'app', 'core.bundle.mjs')
const built = existsSync(bundlePath)
const fixture = join(process.cwd(), 'fixtures', 'projects', 'drift-sensor')

describe.skipIf(!built)('bundled core, as the desktop shell loads it', () => {
  const shell = () => import(pathToFileURL(bundlePath).href) as Promise<Record<string, Function>>

  it('opens a committed view and says every panel is current', async () => {
    const api = await shell()
    const opened = (await api.openView!(fixture, 'drift over time')) as {
      view: { name: string; panels: unknown[] }
      statuses: { state: string }[]
      svgs: string[]
    }

    expect(opened.view.name).toBe('drift over time')
    expect(opened.svgs).toHaveLength(opened.view.panels.length)
    // The bundled copy must find its own `recipes/`: when it looked two levels up from `app/`, every
    // recipe read as missing. Covered here because `src` cannot reproduce that mistake.
    expect(opened.statuses.map((status) => status.state)).toEqual(
      opened.view.panels.map(() => 'current'),
    )
  })

  it('hands the window drawable SVG with identity and provenance intact', async () => {
    const api = await shell()
    const opened = (await api.openView!(fixture, 'drift over time')) as { svgs: string[] }
    const svg = opened.svgs[0]!
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('data-dataset="main"')
    expect(svg).toMatch(/data-point-id="[^"]+"/)
    expect(svg).toContain('</svg>')
  })

  it('refuses a view that does not exist, with the hint the window shows', async () => {
    const api = await shell()
    await expect(api.openView!(fixture, 'not a tab')).rejects.toThrow(/no view named/)
  })

  it('lists projects without opening one', async () => {
    const api = await shell()
    const listed = (await api.projects!()) as { projects: unknown[] }
    expect(Array.isArray(listed.projects)).toBe(true)
  })
})
