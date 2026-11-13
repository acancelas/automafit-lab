# Visual Lab Editor — automafit-lab

**Source:** same portable browser-only editing module as `acancelas/alejandrocancelas-lab`. **Implementation date:** 2026-11-13. **Status:** Prepared module only: the previously empty repository now has an initial README and the editor assets; no site exists.

## Capabilities

The dock is deliberately **unbranded**, in the bottom-right corner. It provides text-fragment editing without losing inline bold/italic, raster image replacement (file/drop/paste), optional **per-element notes**, local draft persistence, undo/redo, and exports: Codex instructions, JSON change manifest and reference HTML. Existing page styles remain unchanged because the editor UI uses Shadow DOM.

All edits are local browser previews. **No GitHub token, backend, database, publishing API or automatic PR.** Export the changes to Codex and apply them to the source repository through a reviewed branch/PR. The exported HTML is for reference, not a direct production artifact (image data URIs and editor-only comments need reconciliation).

## Deployment and access

- **Current host:** Not established; enable only on localhost until the lab hostname and access controls are verified.
- **Integration:** When the first static page exists, add the local script and set the actual staging hostname.
- **Assets:** `assets/editor/visual-lab-editor.js` and `assets/editor/visual-lab-editor.css`.
- **Disable:** add `?editor=off` to a URL.
- **Protection:** lab access should remain behind its existing HTTP Basic Auth. Hostname filtering is not authentication. Do not enable on production.

## HTML insertion for future pages

```html
<script defer src="/assets/editor/visual-lab-editor.js"
  data-ac-lab-editor data-editor-hosts="localhost,127.0.0.1"></script>
```

For a static page, include this near the closing `</body>`, preferably after your regular content. `main` must exist for the default root. For React use the existing bridge, **not** a bare script before React has mounted. A lab behind a different hostname requires an explicit configuration and review; do not add production domains to the allow-list.

## Acceptance checks

1. Verify the dock appears only under the expected lab-host/opt-in conditions.
2. Edit a heading with inline emphasis; check formatting remains intact.
3. Add a note without changing the text; refresh and verify the note is still attached to the correct element.
4. Paste or drop a non-SVG raster image on an existing `img`; refresh and export.
5. Check Codex, JSON and reference HTML exports contain notes and the page/element context.
6. Test navigation and mobile at 390/320 px; observe route changes and dynamic rerenders in SPA labs.
7. Test `?editor=off`, no external requests for editing data and no unauthorized GitHub writes.

**Caveats:** DOM selectors are a best-effort link to content, not source maps. Images and notes are stored only on the current browser origin/device. Do not use sensitive customer data in demo pages. No public/production content is modified by this tool.
