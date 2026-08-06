# Offline Survey Generator

Turns a REDCap Data Dictionary CSV (plus an optional Project XML) into a single self-contained
HTML file that runs a click-through version of the survey with no server, for use when REDCap
is unreachable.

- `index.html` — the generator page. Upload a Data Dictionary CSV (required) and a Project XML
  (optional, for events/arms and the real project title). Runs entirely in the browser.
- `generator.js` — CSV/XML parsing and packaging logic.
- `runtime.js` / `runtime.css` — embedded verbatim into every generated survey; the actual
  offline form engine (branching logic, piping, embedded fields, calculated fields, autosave,
  CSV export back to REDCap's import format).

Nothing here is uploaded anywhere; the generated survey file is a plain download.
