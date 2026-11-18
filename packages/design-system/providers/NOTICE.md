# Provider artwork

Provider marks identify their respective services. They do not indicate an
active connection, paid entitlement, endorsement or affiliation. Custom
connections retain their own initials and never inherit a logo from their name.

Most SVGs are unmodified assets from [Lobe Icons](https://github.com/lobehub/lobe-icons),
commit `55746b0b082258211121c70bd26e6878fd3bd292`, under the
[MIT license](lobe-icons-LICENSE.txt).

The `cherry-*.svg` files are rendered SVG artwork from the independently
MIT-licensed [Cherry Studio UI package](https://github.com/CherryHQ/cherry-studio/tree/d7e53eaf196dc86343c20779f86a0f90f6f8d498/packages/ui),
commit `d7e53eaf196dc86343c20779f86a0f90f6f8d498`. Its complete
[MIT license](cherry-ui-LICENSE.txt) accompanies these files. The React wrappers
were converted to static SVG; generated element IDs are scoped within each file.
Their original paths, embedded images and colors are preserved.

[sources.json](sources.json) records each upstream source path and revision.
`opendesign.svg` extracts the existing editor mark from `../opendesign-dark.svg`
without altering its geometry; see the existing [logo provenance](../opendesign-logo-SOURCE.md).
The TokenHub preset uses a generic cloud symbol because this asset collection
has no verified mark for that service. All artwork is served locally; the UI
never fetches provider logos from third-party hosts.

Brand colors belong to the artwork. The surrounding icon tile, its spacing and
the application shell use the shared design-system tokens in both themes.

Local Agent artwork additions (Kimi, Cursor, Kiro, Kilo, Hermes, Devin, Antigravity, Amp, CodeBuddy, Qoder, Trae and Cline) come from the MIT-licensed [Lobe Icons static SVG collection](https://github.com/lobehub/lobe-icons/tree/master/packages/static-svg/icons), retrieved 2026-11-15. The existing Lobe Icons license applies. Agents without published artwork use a neutral letter mark rather than a different brand.

`fishaudio.svg` is the current navigation mark extracted from the [official Fish Audio website](https://fish.audio/) on 2026-11-17. Its viewBox, geometry and original colors are preserved; only the website layout class was removed. This is Fish Audio brand artwork used to identify its API connection, not an MIT-licensed icon. Ownership remains with Fish Audio. Source and content hash are recorded in `sources.json`.
