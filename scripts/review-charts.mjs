#!/usr/bin/env node
/**
 * Render every chart artifact in a project onto one page, so a human can judge the visuals without
 * opening each SVG by hand. This exists because the charts are the product's appearance of honesty:
 * a band that looks narrower than it is, a caption that contradicts the verdict, or a legend that
 * collides with the data are all invisible in a test and obvious in a screenshot.
 *
 * The page shows each artifact at its natural size and again at 125% and 150%, because the review
 * standard asks about all three, and scaling bugs only appear at one of them.
 *
 * Usage: node scripts/review-charts.mjs [project-dir]
 * Writes: <project>/artifacts/review.html  (regenerable, git-ignored)
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const project = resolve(process.argv[2] ?? join('fixtures', 'projects', 'drift-sensor'))
const artifacts = join(project, 'artifacts')

if (!existsSync(artifacts)) {
  console.error(`no artifacts directory in ${project}`)
  console.error('run a chart command first, for example: bench --project <dir> chart')
  process.exit(2)
}

const files = (await readdir(artifacts)).filter((name) => name.endsWith('.svg')).sort()
if (files.length === 0) {
  console.error(`no .svg artifacts in ${artifacts}`)
  process.exit(2)
}

async function artifact(name) {
  const svg = await readFile(join(artifacts, name), 'utf8')
  // Inline rather than <img>, so the page is one file with no relative-path surprises, and so the
  // caption text is selectable for a copy-paste check against the log.
  const comment = /<!--([\s\S]*?)-->/.exec(svg)?.[1]?.trim() ?? ''
  return { name, svg, comment }
}

const found = await Promise.all(files.map(artifact))

const sections = found
  .map(
    (item) => `
    <section>
      <h2>${item.name}</h2>
      ${item.comment ? `<p class="meta">${escapeHtml(item.comment)}</p>` : ''}
      <div class="scales">
        ${[
          ['100%', 1],
          ['125%', 1.25],
          ['150%', 1.5],
        ]
          .map(
            ([label, scale]) => `
        <figure>
          <figcaption>${label}</figcaption>
          <div class="frame" style="width:${Math.round(880 * scale)}px">
            <div style="zoom:${scale}">
              ${item.svg.replace(/<svg /, `<svg style="width:880px;height:auto" `)}
            </div>
          </div>
        </figure>`,
          )
          .join('\n')}
      </div>
    </section>`,
  )
  .join('\n')

function escapeHtml(text) {
  return text.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character])
}

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Chart review — ${project}</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 32px 40px 80px;
    font-family: "Inter", "Segoe UI", system-ui, sans-serif;
    background: #f6f6f4; color: #1c1c1a;
  }
  h1 { font-size: 15px; font-weight: 600; letter-spacing: .01em; margin: 0 0 4px; }
  .where { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; color: #6b6b66; margin: 0 0 32px; }
  section { margin-bottom: 56px; }
  h2 { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 13px; font-weight: 600; margin: 0 0 4px; }
  .meta { font-size: 12px; color: #6b6b66; margin: 0 0 16px; max-width: 70ch; }
  /* Stacked, not side by side: at 125% and 150% a chart is wider than any sane window, and a
     horizontal scroll on one row is easier to read than three half-visible columns. */
  .scales { display: flex; flex-direction: column; gap: 32px; overflow-x: auto; padding-bottom: 8px; }
  figure { margin: 0; }
  figcaption { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11px; color: #8a8a84; margin-bottom: 6px; }
  .frame { background: #fff; border: 1px solid #e3e3df; border-radius: 4px; padding: 12px; overflow: hidden; }
</style>
</head>
<body>
  <h1>Chart review</h1>
  <p class="where">${project}</p>
  <p class="meta">Each artifact at 100%, 125%, and 150% of its natural size. The caption is the only
  part of the argument a reader has when the file is opened on its own.</p>
  ${sections}
</body>
</html>
`

await mkdir(artifacts, { recursive: true })
const out = join(artifacts, 'review.html')
await writeFile(out, page, 'utf8')
console.log(`review page written to ${out}`)
console.log(`  ${found.length} artifact(s): ${found.map((item) => item.name).join(', ')}`)
