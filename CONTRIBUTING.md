# Contributing to NPY Viewer

Thanks for taking an interest. This document covers how the project is put
together, how to run it, and what a change needs to satisfy before it lands.

## Getting set up

You need Node 20 or newer. Python with NumPy is optional for running the
extension, but you want it for the verification scripts.

```sh
git clone https://github.com/Subhendu-Kumar/npy-viewer-vscode-extension.git
cd npy-viewer-vscode-extension
npm install
npm run watch          # rebuilds both bundles on save
```

Press <kbd>F5</kbd> to launch an Extension Development Host, then open anything
from `sample-npy-files/`. Reload that window (<kbd>Ctrl/Cmd</kbd>+<kbd>R</kbd>)
to pick up rebuilt code.

The webview is a separate bundle, so a change under `src/webview/` needs the
webview reloaded, not just the extension host. **Developer: Reload Webviews**
from the command palette is quicker than restarting the host.

## How the code is arranged

```
src/
  common/types.ts     the host <-> webview contract; no vscode, no node imports
  core/               parsing, statistics, layout detection — pure TypeScript
    dtype.ts          NumPy dtype descriptors and scalar decoding
    npyHeader.ts      .npy header + the Python-literal parser it needs
    reader.ts         byte access: resident for small files, sliding window for large
    npyFile.ts        strided reads — decimated blocks and exact table windows
    stats.ts          the single-pass statistics engine
    layout.ts         shape/dtype -> how to display it
    insights.ts       statistics -> plain-language observations
  python/
    backend.ts        interpreter discovery and subprocess handling
    npy_load.py       the NumPy analysis helper
  editor/             the CustomReadonlyEditorProvider and its HTML shell
  webview/            browser-side code, bundled separately as an IIFE
    views/            one module per tab
```

Three rules keep this from tangling:

1. **`src/common/types.ts` imports nothing.** It is compiled into both bundles,
   so a `vscode` or `node:` import there breaks the webview build.
2. **`src/core/` never imports `vscode`.** That is what lets the whole parsing
   and statistics layer be tested and benchmarked under plain Node.
3. **The webview never touches the filesystem.** It asks the host for blocks and
   table windows over `postMessage` and renders what comes back.

### The one abstraction worth understanding

Every array — an RGB photo, a PyTorch NCHW batch, a hyperspectral cube, a
rank-5 tensor — is normalised by `detectLayout` into a single shape:

```
frames x height x width x channels
```

`Layout` records which axis plays which role. Image, heatmap, contact-sheet and
slice-navigation views all consume that one structure, so a new visual almost
never needs new read code. If you find yourself adding a second way to address
elements, that is a sign the change belongs in `layout.ts` instead.

## Running the checks

```sh
npm run check-types    # tsc --noEmit
npm run lint           # eslint
npm test               # the suite, in a real extension host
```

`npm test` downloads VS Code the first time. If that is slow or blocked, the
core suite has no `vscode` dependency and runs directly:

```sh
npx esbuild src/test/core.test.ts --bundle --platform=node --format=cjs \
  --outfile=/tmp/core-tests.js
node -e "
const cases=[];globalThis.suite=(n,f)=>f();globalThis.test=(n,f)=>cases.push([n,f]);
require('/tmp/core-tests.js');
(async()=>{let bad=0;for(const [n,f] of cases){try{await f()}catch(e){bad++;console.log('FAIL',n,e.message)}}
console.log(cases.length-bad+' passing, '+bad+' failing')})()"
```

## Verifying against NumPy

NumPy is the reference implementation. Anything that touches parsing or
statistics should be checked against it rather than against expectations.

```sh
cd sample-npy-files
python generate.py            # 37 arrays covering every dtype and view
python generate.py --large    # plus a 500 MB array, to exercise streaming
```

Write a small script that runs `computeStats` over each file and compares the
result to `numpy`. Watch for two traps that have already caught us:

- **Values near 2⁵³.** `float64` cannot hold every `int64`, so statistics over
  such arrays carry roughly `ulp / spread` relative error in _both_
  implementations. Scale your tolerance instead of tightening it.
- **`Buffer.from(text, 'base64')` returns a view into Node's shared pool.**
  Reading `.buffer` without `.byteOffset` decodes unrelated memory. This looks
  like a parser bug and is not.

## Making a change

### Adding a dtype

`parseDescr` in `core/dtype.ts` maps the descriptor, `makeScalarReader` reads it
as a number for statistics and plotting, and `formatScalar` renders it exactly
for the data table. Those last two differ on purpose: 64-bit integers are
approximated in the first and exact in the second. Add a fixture to
`generate.py` and a case to `core.test.ts`.

### Adding a view

Add the kind to `ViewKind`, teach `detectLayout` when to choose it, and add a
module under `webview/views/`. Consume `Layout` — do not read the array a new
way.

### Adding a statistic

Extend `NumericStats`, compute it in `core/stats.ts`, and mirror it in
`python/npy_load.py`. **Both backends must agree**, so a statistic that only one
can compute needs an explicit null on the other side rather than a silent
difference. Surface it in `views/stats.ts`.

### Adding a colormap

Add anchor colours to `RAMPS` in `webview/colormap.ts` and the name to the
`npyViewer.view.colormap` enum in `package.json`. Sequential ramps should be
perceptually uniform; a diverging one also belongs in the `DIVERGING` set so it
gets centred on zero.

## What a change has to hold to

**Correctness is measured, not asserted.** If you change a number the viewer
reports, show it still matches NumPy.

**The memory budget is real.** The extension host is shared with every other
extension the user has installed. Arrays above 96 MB stream rather than load,
previews are capped before crossing into the webview, and the statistics sample
is bounded. A change that allocates proportionally to array size needs a
deliberate justification — we already shipped one that peaked at 1.9 GB and had
to walk it back.

**Say what is true.** Statistics that are sampled are labelled approximate;
values that cannot be represented exactly say so. Do not describe an estimate as
exact, in the UI or in the docs.

**Themes are VS Code's job.** Colour comes from `--vscode-*` tokens so the
viewer is correct in light, dark and high-contrast without a palette of our own.
Hard-coded hex belongs only in the scientific colormaps.

**The viewer is read-only.** It never writes to the file it is displaying.

## Style

TypeScript is strict; `any` needs a reason. Formatting is Prettier's defaults —
run your editor's formatter, or `npx prettier --write .`. Comments should
explain why a piece of code is the way it is, not restate what it does; the
existing ones are the reference.

Commits: short imperative subject, and a body when the reasoning is not obvious
from the diff.

## Reporting a bug

The array is usually the whole story, so please include:

- the **shape and dtype** (the Metadata tab lists both, and it is copyable),
- which **backend** ran — the badge in the header says `NumPy x.y` or
  `Built-in parser`,
- what you expected to see versus what rendered,
- the **NPY Viewer** output channel if anything failed to open.

A snippet of the `numpy` code that produced the file is more useful than the
file itself, and easier to attach.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:
type-check, lint and the full suite on Linux and Windows, then packages the
extension and attaches the `.vsix` to the run so a change can be installed and
tried by hand.

A second job installs NumPy and runs `.github/scripts/check_backend.py`, which
drives the shipped `src/python/npy_load.py` as a subprocess over every sample
array and compares its output to NumPy directly. That file is copied verbatim
into the package, so it needs coverage of its own.

## Cutting a release

Releases are made by tagging. Update the changelog first — the workflow refuses
to publish a version that has no section.

```sh
# 1. Add a "## [0.1.0] - YYYY-MM-DD" section to CHANGELOG.md and commit it.
# 2. Bump the manifest and tag in one step.
npm version 0.1.0 -m "Release %s"
# 3. Push the commit and its tag.
git push origin main --follow-tags
```

`.github/workflows/release.yml` then takes over. Before building anything it
checks that the tag matches `package.json` and that the changelog has notes for
it, so a mistyped tag fails in seconds rather than after a full test run. It
then runs the same checks as CI, packages the extension, verifies that the
bundles and the Python loader are actually inside the `.vsix` — they are copied
by an esbuild plugin rather than bundled, so a silent copy failure would
otherwise ship — and creates the GitHub release with the `.vsix` attached.

A version containing a hyphen (`0.1.0-rc.1`) is published as a pre-release.

Nothing is pushed to the VS Code Marketplace; publishing there is still a
deliberate manual step (`npx @vscode/vsce publish`).

## Licence

The project is [MIT licensed](LICENSE). By contributing you agree that your
work is released under those same terms.
