import { describe, expect, it } from 'vitest'
import { incrementalMark, renderChart, ticks, wrapCaption } from '../src/core/chart.ts'

const base = { x: { label: 'x' }, y: { label: 'y' } }

describe('incrementalMark', () => {
  const spec = {
    ...base,
    points: [
      { x: 1, y: 2, id: 'p1' },
      { x: 2, y: 4, id: 'p2' },
      { x: 3, y: 6, id: 'p3' },
    ],
    footer: 'n = 3 · no fit — unmodelled',
  }

  it('produces exactly the markup a redraw would, character for character', () => {
    const point = { x: 2.5, y: 5, id: 'p4' }
    const mark = incrementalMark(spec, point)
    expect(mark).not.toBeNull()

    // The whole point of patching rather than redrawing is that the two are indistinguishable. A
    // test that compared rounded numbers would let a drift of one attribute through; comparing the
    // strings cannot.
    const redrawn = renderChart({ ...spec, points: [...spec.points, point] })
    expect(redrawn).toContain(mark!)
    expect(mark!.startsWith('<circle ')).toBe(true)
    expect(mark!).toContain('data-point-id="p4"')
  })

  it('refuses a mark that would move the axes, so the caller has to redraw', () => {
    // Outside the domain a redraw rescales, and a mark drawn against the old scale would be wrong.
    expect(incrementalMark(spec, { x: 1000, y: 5, id: 'far' })).toBeNull()
    expect(incrementalMark(spec, { x: 2, y: -500, id: 'far' })).toBeNull()
  })

  it('accepts a value inside the padded domain that no drawn point reaches', () => {
    // The domain is padded by 6% of the range: x spans [0.88, 3.12] and y [1.76, 6.24] here. A new
    // value can be outside every drawn point and still not move the axes, which is the case that
    // makes patching worthwhile — and the boundary is what the next assertion pins.
    expect(incrementalMark(spec, { x: 0.9, y: 6.2, id: 'p0' })).not.toBeNull()
    expect(incrementalMark(spec, { x: 0.8, y: 6.2, id: 'p0' })).toBeNull()
  })

  it('places a mark relative to a fitted line as well as to points', () => {
    const fitted = { ...base, line: [{ x: 0, y: 0 }, { x: 10, y: 20 }] }
    expect(incrementalMark(fitted, { x: 5, y: 10, id: 'm' })).not.toBeNull()
    expect(incrementalMark(fitted, { x: 5, y: 90, id: 'm' })).toBeNull()
  })
})

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

describe('wrapCaption', () => {
  it('leaves a short caption on one line', () => {
    expect(wrapCaption('n = 12 · supported')).toEqual(['n = 12 · supported'])
  })

  it('wraps long prose without splitting or losing words', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet'
    // A high line limit so nothing is truncated: this is about wrapping, not clipping.
    const lines = wrapCaption(text, 20, 50)

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(20)
      for (const word of line.split(' ')) expect(word).not.toBe('')
    }
    expect(lines.join(' ')).toBe(text)
    expect(lines.length).toBeGreaterThan(1)
  })

  it('caps at three lines and signals the truncation', () => {
    const lines = wrapCaption('word '.repeat(200), 40, 3)
    expect(lines).toHaveLength(3)
    expect(lines[2]!.endsWith('…')).toBe(true)
  })

  it('returns nothing for empty text', () => {
    expect(wrapCaption('')).toEqual([])
    expect(wrapCaption('   ')).toEqual([])
  })
})

describe('renderChart', () => {
  it('renders a caption with its own class, inside a fixed canvas', () => {
    const svg = renderChart({
      ...base,
      points: [{ x: 1, y: 1 }],
      caption: 'Twelve points, two parameters: the fit beats a mean-only model.',
    })

    expect(svg).toContain('class="caption"')
    expect(svg).toContain('Twelve points, two parameters')
    expect(svg).toContain('viewBox="0 0 760 440"')
    expect(svg).toContain('height="440"')
  })

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

  it('draws several regimes, dashing the secondary one, with a legend', () => {
    const svg = renderChart({
      ...base,
      points: [
        { x: 1, y: 2 },
        { x: 2, y: 5 },
      ],
      lines: [
        { points: [{ x: 1, y: 2 }, { x: 2, y: 4 }], label: 'before 2026-10-10' },
        { points: [{ x: 1, y: 3 }, { x: 2, y: 5 }], label: 'after 2026-10-10', muted: true },
      ],
      footer: 'n = 2 · 2 regimes · tentative',
    })

    expect((svg.match(/<path /g) ?? []).length).toBe(2)
    expect(svg).toContain('stroke-dasharray="6 4"')
    expect(svg).toContain('class="legend"')
    expect(svg).toContain('before 2026-10-10')
    expect(svg).toContain('after 2026-10-10')

    // One accent hue only: a second colour would claim a ranking that is not there.
    const allowed = new Set(['#1f6feb', '#71767c', '#ffffff', '#e8eaed'])
    const strokes = [...svg.matchAll(/stroke="(#[0-9a-f]{6})"/gi)].map((match) => match[1]!.toLowerCase())
    expect(strokes.length).toBeGreaterThan(0)
    for (const stroke of strokes) expect(allowed.has(stroke)).toBe(true)
  })

  it('ignores a series too short to draw, and does not name it in the legend', () => {
    const svg = renderChart({
      ...base,
      points: [{ x: 1, y: 1 }],
      lines: [{ points: [{ x: 1, y: 1 }], label: 'lonely' }],
    })
    expect(svg).not.toContain('<path ')
    expect(svg).not.toContain('class="legend"')
    expect(svg).not.toContain('lonely')
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

  it('emits well-formed XML, not merely markup an HTML parser forgives', () => {
    const svg = renderChart({
      ...base,
      title: 't',
      subtitle: 's',
      footer: 'n = 2',
      caption: 'a caption',
      provenance: { dataset: 'main', shape: 'xy.v1' },
      points: [{ x: 1, y: 2, id: 'p1' }],
      line: [
        { x: 1, y: 2 },
        { x: 2, y: 3 },
      ],
      lines: [{ points: [{ x: 1, y: 2 }], label: 'regime' }],
    })

    // The font stacks used to contain double quotes, which closed the attribute they sat in and made
    // the whole document unparseable as XML — the desktop window refused every chart. A browser
    // loading it as HTML hides that, so check the property directly: every tag is a name followed by
    // `name="value"` pairs, which is exactly what a stray quote breaks.
    const tag = /^<\/?([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>$/
    const tags = svg.match(/<[^>]+>/g) ?? []
    expect(tags.length).toBeGreaterThan(10)
    for (const matched of tags) expect(matched, matched).toMatch(tag)
  })

  it("writes each point's identity onto the mark, so a hover has something to resolve", () => {
    const svg = renderChart({
      x: { label: 'x' },
      y: { label: 'y' },
      points: [
        { x: 1, y: 2, id: '01ABC' },
        { x: 3, y: 4 },
      ],
    })

    expect(svg).toContain('data-point-id="01ABC"')
    // One identified, one anonymous: an anonymous point still draws, it just cannot be traced.
    expect(svg.match(/data-point-id=/g)).toHaveLength(1)
    expect(svg.match(/<circle /g)).toHaveLength(2)
  })

  it('escapes an identity rather than letting it break the markup', () => {
    const svg = renderChart({
      x: { label: 'x' },
      y: { label: 'y' },
      points: [{ x: 1, y: 2, id: '"><script>alert(1)</script>' }],
    })

    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
  })

  it('records what the artifact was drawn from, on the root element', () => {
    const svg = renderChart({
      x: { label: 'x' },
      y: { label: 'y' },
      provenance: { dataset: 'main', shape: 'xy.v1' },
      points: [{ x: 1, y: 2 }],
    })

    expect(svg).toContain('data-dataset="main"')
    expect(svg).toContain('data-shape="xy.v1"')
  })

  it('omits provenance it was not given rather than inventing a source', () => {
    const svg = renderChart({ x: { label: 'x' }, y: { label: 'y' }, points: [{ x: 1, y: 2 }] })
    expect(svg).not.toContain('data-dataset')
    expect(svg).not.toContain('data-shape')
  })

  it('renders a single point without dividing by zero', () => {
    const svg = renderChart({ ...base, points: [{ x: 5, y: 5 }] })
    expect(svg).toContain('<circle')
    expect(svg).not.toContain('Infinity')
  })
})
