/** Coerce `--param k=v` text into the type the recipe declared. */
export function parseParams(
  entries: string[] | undefined,
  die: (message: string, code?: number, hint?: string) => never,
): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const entry of entries ?? []) {
    const separator = entry.indexOf('=')
    if (separator <= 0) die(`--param must look like name=value, got "${entry}"`)
    const name = entry.slice(0, separator).trim()
    const raw = entry.slice(separator + 1).trim()
    if (raw === 'true') params[name] = true
    else if (raw === 'false') params[name] = false
    else if (raw !== '' && Number.isFinite(Number(raw))) params[name] = Number(raw)
    else params[name] = raw
  }
  return params
}
