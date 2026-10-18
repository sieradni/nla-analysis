import { describe, expect, it } from 'vitest'
import { renderChart, ticks } from '../src/core/chart.ts'

const base = { x: { label: 'x' }, y: { label: 'y' } }

describe('ticks', () => {
  it('produces evenly spaced, rounded values inside the domain', () => {
    const values = ticks(0, 10, 5)
    expect(values).toEqual([0, 2, 4, 6, 8, 10])
  })

  it('handles a collapsed domain', () => {
    expect(ticks(3, 3)).toEqual([3])
  })

  it('never emits non-finite values', () => {
    for (const value of ticks(-1e-4, 1e-4)) expect(Number.isFinite(value)).toBe(true)
  })
})

describe('renderChart', () => {
  it('renders a valid svg with the footer evidence line', () => {
    const svg = renderChart({
      ...base,
      points: [
        { x: 1, y: 2 },
        { x: 2, y: 3 },
      ],
      footer: 'n = 2 · no fit — unmodelled',
    })

    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
    expect(svg).toContain('n = 2 · no fit — unmodelled')
    expect(svg).not.toContain('NaN')
  })

  it('stacks the evidence line below the subtitle without overlapping it', () => {
    const svg = renderChart({
      ...base,
      title: 'drift-sensor',
      subtitle: 'main · xy.v1',
      points: [{ x: 1, y: 1 }],
      footer: 'n = 1 · unmodelled',
    })

    const textElements = [...svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)].map((match) => ({
      y: Number(/y="([\d.]+)"/.exec(match[1] ?? '')?.[1]),
      content: match[2] ?? '',
    }))
    const yOf = (content: string): number => {
      const found = textElements.find((element) => element.content === content)
      expect(found, `no text element containing "${content}"`).toBeDefined()
      return found!.y
    }

    const subtitleY = yOf('main · xy.v1')
    const footerY = yOf('n = 1 · unmodelled')
    expect(footerY).toBeGreaterThanOrEqual(subtitleY + 10)
  })

  it('draws the interval band before the line', () => {
    const svg = renderChart({
      ...base,
      line: [
        { x: 0, y: 1 },
        { x: 1, y: 2 },
      ],
      band: [
        { x: 0, y0: 0.5, y1: 1.5 },
        { x: 1, y0: 1.5, y1: 2.5 },
      ],
    })

    const bandIndex = svg.indexOf('fill-opacity="0.14"')
    const lineIndex = svg.indexOf('stroke-width="2"')
    expect(bandIndex).toBeGreaterThan(-1)
    expect(lineIndex).toBeGreaterThan(bandIndex)
  })

  it('escapes text that would otherwise break the document', () => {
    const svg = renderChart({ ...base, title: 'a < b & "c"' })
    expect(svg).toContain('a &lt; b &amp; &quot;c&quot;')
  })

  it('renders a single point without dividing by zero', () => {
    const svg = renderChart({ ...base, points: [{ x: 5, y: 5 }] })
    expect(svg).toContain('<circle')
    expect(svg).not.toContain('Infinity')
  })
})
