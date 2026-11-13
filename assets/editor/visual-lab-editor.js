/**
 * AC Visual Lab Editor v1
 *
 * Framework-agnostic, browser-only visual editing for protected staging labs.
 * - Text editing preserves inline markup by changing individual text nodes.
 * - Image replacements are stored in IndexedDB on this origin.
 * - Text changes are stored in localStorage on this origin.
 * - Export a reproducible change manifest / Codex instructions / preview HTML.
 *
 * This code does not authenticate users, write to GitHub, or publish a website.
 * Host access control (e.g. HTTP Basic Auth) is mandatory in a staging lab.
 */
(() => {
  "use strict";

  const bootstrap = document.currentScript || document.querySelector("script[data-ac-lab-editor]");
  const defaultHosts = "lab.alejandrocancelas.com,localhost,127.0.0.1";
  const allowedHosts = (bootstrap?.dataset.editorHosts || defaultHosts)
    .split(",").map(value => value.trim().toLowerCase()).filter(Boolean);

  if (!allowedHosts.includes(window.location.hostname.toLowerCase())) return;
  if (new URLSearchParams(window.location.search).get("editor") === "off") return;
  if (bootstrap?.dataset.editorOptin === "true" &&
      new URLSearchParams(window.location.search).get("editor") !== "on") return;

  // Most sites expose <main>. React labs may use a persistent #root and
  // hash-router demos a stable <body>. These options do not confer access.
  const rootSelector = bootstrap?.dataset.editorRoot || "main";
  const routeMode = bootstrap?.dataset.editorRoute || "pathname";
  const spaMode = bootstrap?.dataset.editorSpa === "true";
  const page = document.querySelector(rootSelector);
  if (!page || document.getElementById("acve-root")) return;
  function currentPageKey() {
    const pathname = window.location.pathname === "/" ? "/index.html" : window.location.pathname;
    return routeMode === "hash" ? pathname + window.location.hash : pathname;
  }
  let pagePath = currentPageKey();
  let storageKey = "ac-visual-lab-editor:v1:" + pagePath;
  const databaseName = "ac-visual-lab-editor-assets-v1";
  const databaseStore = "images";
  const maxImageSize = 16 * 1024 * 1024;
  const acceptedImageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
  const maxUndoItems = 35;
  const editorIcons = {
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M4 17.5V20h3l11-11-3-3L4 17.5ZM14.5 6.5l3 3"/></svg>',
    eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.7-7 10-7 10 7 10 7-3.7 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
    redo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3"/></svg>',
    export: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5 5 19"/></svg>',
    save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h13l3 3v15H3V3h2Zm3 0v7h9V3M7 21v-8h10v8"/></svg>',
    image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m3 17 5-5 4 4 3-3 6 5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6m4-6v6"/></svg>'
  };
  const allowedSelector = [
    "img", "h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "button",
    "li", "blockquote", "figcaption", "label", "span", "em", "strong", "small",
    "time", "cite"
  ].join(",");

  let editing = false;
  let selected = null;
  let hovered = null;
  let undoStack = [];
  let redoStack = [];
  let textPatches = new Map();
  let imagePatches = new Map();
  let notePatches = new Map();
  let staleDraft = { text: [], images: [], notes: [] };
  let toastTimer = 0;
  let dbPromise = null;

  const uiRoot = document.createElement("div");
  uiRoot.id = "acve-root";
  const shadow = uiRoot.attachShadow({ mode: "open" });
  shadow.innerHTML = [
    '<link rel="stylesheet" href="/assets/editor/visual-lab-editor.css">',
    '<div class="dock" role="toolbar" aria-label="Herramientas de edición del laboratorio">',
      '<button type="button" id="acve-toggle" class="dock-button" title="Activar modo edición" aria-label="Activar modo edición">',
        editorIcons.edit, '</button>',
      '<button type="button" id="acve-undo" class="dock-button" title="Deshacer" aria-label="Deshacer" disabled>',
        editorIcons.undo, '</button>',
      '<button type="button" id="acve-redo" class="dock-button" title="Rehacer" aria-label="Rehacer" disabled>',
        editorIcons.redo, '</button>',
      '<button type="button" id="acve-export" class="dock-button dock-accent" title="Exportar cambios" aria-label="Exportar cambios">',
        editorIcons.export, '</button>',
    '</div>',
    '<section id="acve-panel" class="panel" aria-label="Editor visual" hidden>',
      '<div class="panel-top"><div><span class="mini-label">EDITOR DE CONTENIDO</span>',
        '<h2 id="acve-panel-title">Selecciona un elemento</h2></div>',
        '<button type="button" id="acve-close" class="icon-button" aria-label="Cerrar panel">',
          editorIcons.close, '</button></div>',
      '<p id="acve-subtitle" class="panel-subtitle"></p>',
      '<div id="acve-body" class="panel-body"></div>',
      '<div class="panel-footer">',
        '<button type="button" id="acve-save" class="primary-action">Guardar borrador ',editorIcons.save,'</button>',
        '<span id="acve-count" class="change-counter">Sin cambios</span>',
      '</div>',
    '</section>',
    '<section id="acve-export-panel" class="panel export-panel" aria-label="Exportación de cambios" hidden>',
      '<div class="panel-top"><div><span class="mini-label">ENTREGA PARA CÓDIGO</span>',
        '<h2>Exportar cambios</h2></div>',
        '<button type="button" id="acve-export-close" class="icon-button" aria-label="Cerrar exportación">',
          editorIcons.close, '</button></div>',
      '<p class="panel-subtitle">El borrador es local. Ninguna acción de este editor publica archivos ni modifica GitHub.</p>',
      '<div class="export-actions">',
        '<button type="button" data-export-action="instructions">',editorIcons.copy,' Copiar instrucciones para Codex</button>',
        '<button type="button" data-export-action="manifest">',editorIcons.export,' Descargar cambios JSON</button>',
        '<button type="button" data-export-action="html-copy">',editorIcons.copy,' Copiar HTML completo</button>',
        '<button type="button" data-export-action="html-download">',editorIcons.export,' Descargar HTML de referencia</button>',
        '<button type="button" data-export-action="html-show">',editorIcons.edit,' Seleccionar código HTML</button>',
      '</div>',
      '<textarea id="acve-html-preview" class="code-preview" readonly hidden aria-label="Código HTML de la página con los cambios"></textarea>',
      '<p class="export-help">Las imágenes sustituidas se incrustan en el HTML exportado. Es una referencia de revisión, no código listo para publicar en producción. Utiliza Codex para incorporar los cambios al código fuente.</p>',
      '<button type="button" id="acve-reset" class="danger-action">',editorIcons.trash,' Descartar todos los cambios de esta página</button>',
    '</section>',
    '<div id="acve-toast" class="toast" role="status" aria-live="polite" hidden></div>'
  ].join("");
  document.body.appendChild(uiRoot);

  const globalStyle = document.createElement("style");
  globalStyle.id = "acve-outline-style";
  globalStyle.textContent = [
    ".acve-hover { outline: 2px dashed #4bd5cb !important; outline-offset: 4px !important; cursor: crosshair !important; }",
    ".acve-selected { outline: 3px solid #33ddcf !important; outline-offset: 5px !important; }",
    ".acve-hover.acve-selected { outline-style: solid !important; }"
  ].join("\n");
  document.head.appendChild(globalStyle);

  const $ = id => shadow.getElementById(id);
  const toggleButton = $("acve-toggle");
  const undoButton = $("acve-undo");
  const redoButton = $("acve-redo");
  const exportButton = $("acve-export");
  const editPanel = $("acve-panel");
  const exportPanel = $("acve-export-panel");
  const panelTitle = $("acve-panel-title");
  const panelSubtitle = $("acve-subtitle");
  const panelBody = $("acve-body");
  const changesLabel = $("acve-count");
  const toast = $("acve-toast");
  const codePreview = $("acve-html-preview");

  function notify(message) {
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 4900);
  }

  function countChanges() {
    return textPatches.size + imagePatches.size + notePatches.size +
      staleDraft.text.length + staleDraft.images.length + staleDraft.notes.length;
  }

  function refreshToolbar() {
    toggleButton.innerHTML = editing ? editorIcons.eye : editorIcons.edit;
    toggleButton.title = editing ? "Salir del modo edición" : "Activar modo edición";
    toggleButton.setAttribute("aria-label", toggleButton.title);
    toggleButton.classList.toggle("is-active", editing);
    undoButton.disabled = undoStack.length === 0;
    redoButton.disabled = redoStack.length === 0;
    const changes = countChanges();
    changesLabel.textContent = changes === 0 ? "Sin cambios" : changes + (changes === 1 ? " cambio" : " cambios");
    exportButton.classList.toggle("has-changes", changes > 0);
  }

  function safeTagName(element) {
    return element.tagName.toLowerCase();
  }

  function elementSelector(element) {
    if (!element || !page.contains(element)) return null;
    const segments = [];
    let current = element;
    while (current && current !== page) {
      let order = 1;
      for (let previous = current.previousElementSibling; previous; previous = previous.previousElementSibling) {
        if (previous.tagName === current.tagName) order++;
      }
      segments.unshift(safeTagName(current) + ":nth-of-type(" + order + ")");
      current = current.parentElement;
    }
    if (current !== page) return null;
    const rootPath = rootSelector === "main"
      ? "main" + (page.id ? "[id=\"" + page.id.replace(/"/g, "\\\"") + "\"]" : "")
      : rootSelector;
    return rootPath + " > " + segments.join(" > ");
  }

  function lookupElement(selector) {
    try {
      const item = document.querySelector(selector);
      return item && page.contains(item) ? item : null;
    } catch {
      return null;
    }
  }

  function textNodesFor(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const result = [];
    let item;
    while ((item = walker.nextNode())) {
      const parent = item.parentElement;
      if (parent?.closest("script,style,noscript,svg")) continue;
      result.push(item);
    }
    return result;
  }

  function textKey(selector, index) {
    return selector + "::text:" + index;
  }

  function imageKey(selector) {
    return pagePath + "::image:" + selector;
  }

  function elementNoteContext(element, selector) {
    if (!element) return "";
    if (element instanceof HTMLImageElement) {
      const existingImagePatch = imagePatches.get(selector);
      return (existingImagePatch?.originalSrc || element.getAttribute("src") || "").slice(0, 240);
    }
    return (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 240);
  }

  function syncNoteContext(selector, element) {
    const patch = notePatches.get(selector);
    if (!patch) return;
    patch.context = elementNoteContext(element, selector);
  }

  function updateNote(selector, value) {
    const element = lookupElement(selector);
    if (!element) return;
    if (!value.trim()) {
      notePatches.delete(selector);
    } else {
      notePatches.set(selector, {
        selector,
        tag: element.tagName.toLowerCase(),
        context: elementNoteContext(element, selector),
        note: value
      });
    }
    staleDraft.notes = staleDraft.notes.filter(patch => patch.selector !== selector);
    persistDraft();
    refreshToolbar();
  }

  function editableFromEvent(event) {
    const origin = event.target instanceof Element ? event.target : null;
    if (!origin || !page.contains(origin)) return null;
    const image = origin.closest("img");
    if (image && page.contains(image)) return image;
    // Canonical block-level selection prevents overlapping patches for nested <em>/<strong>.
    // Each block retains its inline markup and exposes its individual text nodes in the inspector.
    const candidate = origin.closest("h1,h2,h3,h4,h5,h6,p,blockquote,li,figcaption,label,button,a") ||
      origin.closest("span,em,strong,small,time,cite");
    if (!candidate || !page.contains(candidate)) return null;
    if (candidate.closest("[data-acve-ignore],script,style,noscript")) return null;
    const selector = elementSelector(candidate);
    return textNodesFor(candidate).some(node => (node.nodeValue || "").trim()) ||
      [...textPatches.values()].some(patch => patch.selector === selector)
      ? candidate : null;
  }

  function setHovered(element) {
    if (hovered === element) return;
    if (hovered) hovered.classList.remove("acve-hover");
    hovered = element;
    if (hovered && editing) hovered.classList.add("acve-hover");
  }

  function setSelected(element) {
    if (selected?.element) selected.element.classList.remove("acve-selected");
    if (!element) {
      selected = null;
      editPanel.hidden = true;
      return;
    }
    const selector = elementSelector(element);
    if (!selector) return;
    element.classList.add("acve-selected");
    selected = { element, selector, type: element.matches("img") ? "image" : "text" };
    exportPanel.hidden = true;
    editPanel.hidden = false;
    renderInspector();
  }

  function createField(labelText, value, options = {}) {
    const wrapper = document.createElement("label");
    wrapper.className = "field";
    const name = document.createElement("span");
    name.className = "field-label";
    name.textContent = labelText;
    wrapper.appendChild(name);
    const control = document.createElement(options.multiline ? "textarea" : "input");
    control.className = options.multiline ? "field-textarea" : "field-input";
    if (options.multiline) control.rows = 3;
    else control.type = "text";
    control.value = value;
    wrapper.appendChild(control);
    return { wrapper, control };
  }

  function storeSnapshot() {
    undoStack.push({
      text: [...textPatches.values()].map(patch => ({ ...patch })),
      images: [...imagePatches.values()].map(patch => ({ ...patch })),
      notes: [...notePatches.values()].map(patch => ({ ...patch }))
    });
    if (undoStack.length > maxUndoItems) undoStack.shift();
    redoStack.length = 0;
    refreshToolbar();
  }

  function persistDraft() {
    const payload = {
      version: 1,
      text: [...textPatches.values(), ...staleDraft.text],
      images: [
        ...[...imagePatches.values()].map(({ dataUrl, ...rest }) => rest),
        ...staleDraft.images
      ],
      notes: [...notePatches.values(), ...staleDraft.notes],
      savedAt: new Date().toISOString()
    };
    try {
      if (payload.text.length || payload.images.length || payload.notes.length) {
        window.localStorage.setItem(storageKey, JSON.stringify(payload));
      } else {
        window.localStorage.removeItem(storageKey);
      }
      return true;
    } catch {
      notify("No se pudo guardar en el navegador. Exporta tus cambios antes de salir.");
      return false;
    }
  }

  function updateText(selector, nodeIndex, inputText) {
    const element = lookupElement(selector);
    const node = element ? textNodesFor(element)[nodeIndex] : null;
    if (!node) return;
    const key = textKey(selector, nodeIndex);
    const previous = textPatches.get(key);
    const original = previous ? previous.original : node.nodeValue || "";
    node.nodeValue = inputText;
    if (inputText === original) {
      textPatches.delete(key);
    } else {
      textPatches.set(key, { selector, nodeIndex, original, value: inputText });
    }
    syncNoteContext(selector, element);
    persistDraft();
    refreshToolbar();
  }

  function updateImageAlt(value) {
    if (selected?.type !== "image") return;
    const element = selected.element;
    const selector = selected.selector;
    const old = imagePatches.get(selector);
    const originalAlt = old ? old.originalAlt : element.getAttribute("alt") || "";
    const originalSrc = old ? old.originalSrc : element.getAttribute("src") || "";
    element.setAttribute("alt", value);
    if (value === originalAlt && !(old?.dataUrl || old?.filename)) {
      imagePatches.delete(selector);
    } else {
      imagePatches.set(selector, { ...old, selector, originalSrc, originalAlt, alt: value });
    }
    persistDraft();
    refreshToolbar();
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
  }

  function openDatabase() {
    if (!("indexedDB" in window)) return Promise.reject(new Error("IndexedDB no disponible"));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(databaseStore)) {
          request.result.createObjectStore(databaseStore, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB no disponible"));
    });
    return dbPromise;
  }

  async function writeImageAsset(key, dataUrl, filename, mime) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(databaseStore, "readwrite");
      transaction.objectStore(databaseStore).put({ id: key, dataUrl, filename, mime });
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error || new Error("No se pudo guardar la imagen"));
    });
  }

  async function readImageAsset(key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(databaseStore, "readonly");
      const request = transaction.objectStore(databaseStore).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("No se pudo leer la imagen"));
    });
  }

  async function deleteImageAsset(key) {
    try {
      const db = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(databaseStore, "readwrite");
        transaction.objectStore(databaseStore).delete(key);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
    } catch {
      /* Non-critical: draft still resets even if the browser blocks IndexedDB. */
    }
  }

  async function replaceImage(file) {
    if (selected?.type !== "image") return;
    if (!file || !acceptedImageTypes.has(file.type)) {
      notify("Selecciona un PNG, JPEG, WebP, GIF o AVIF. Los SVG no se admiten.");
      return;
    }
    if (file.size > maxImageSize) {
      notify("La imagen supera 16 MB. Optimízala antes de sustituirla.");
      return;
    }
    const target = selected.element;
    const selector = selected.selector;
    let dataUrl;
    try {
      dataUrl = await readFileAsDataUrl(file);
    } catch {
      notify("No se pudo leer la imagen seleccionada.");
      return;
    }
    if (selected?.element !== target) return;
    storeSnapshot();
    const previous = imagePatches.get(selector);
    const originalSrc = previous ? previous.originalSrc : target.getAttribute("src") || "";
    const originalAlt = previous ? previous.originalAlt : target.getAttribute("alt") || "";
    const filename = file.name.replace(/[^\w.() -]/g, "_").slice(0,120) || "replacement-image";
    const patch = {
      selector, originalSrc, originalAlt,
      alt: target.getAttribute("alt") || "",
      filename, mime: file.type, byteSize: file.size, dataUrl
    };
    imagePatches.set(selector, patch);
    target.setAttribute("src", dataUrl);
    syncNoteContext(selector, target);
    persistDraft();
    refreshToolbar();
    renderInspector();
    try {
      await writeImageAsset(imageKey(selector), dataUrl, filename, file.type);
      notify("Imagen sustituida. El borrador se ha guardado en este navegador.");
    } catch {
      notify("Imagen visible, pero no se ha podido conservar tras recargar. Exporta el HTML.");
    }
  }

  function renderInspector() {
    if (!selected) return;
    const { element, selector, type } = selected;
    panelBody.replaceChildren();
    panelTitle.textContent = type === "image" ? "Sustituir imagen" : "Editar texto";
    panelSubtitle.textContent = type === "image"
      ? "Elige una imagen, arrástrala o pégala con Ctrl/Cmd + V."
      : "Edita cada fragmento sin perder negritas, cursivas, enlaces o estilos.";

    if (type === "text") {
      const allNodes = textNodesFor(element);
      const visible = allNodes.map((node, index) => ({ node, index }))
        .filter(item => (item.node.nodeValue || "").trim().length > 0 || textPatches.has(textKey(selector, item.index)));

      if (!visible.length) {
        const notice = document.createElement("p");
        notice.className = "hint";
        notice.textContent = "No hay texto editable en este elemento, pero puedes añadir una nota.";
        panelBody.appendChild(notice);
      }
      visible.forEach(({ node, index }, position) => {
        const existing = textPatches.get(textKey(selector, index));
        const { wrapper, control } = createField(
          visible.length === 1 ? "Contenido" : "Fragmento " + (position + 1),
          existing?.value ?? node.nodeValue ?? "",
          { multiline: true }
        );
        let captured = false;
        control.addEventListener("focus", () => {
          if (!captured) {
            storeSnapshot();
            captured = true;
          }
        });
        control.addEventListener("input", () => updateText(selector, index, control.value));
        panelBody.appendChild(wrapper);
      });

      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = "Puedes usar Ctrl/Cmd + A, C y V dentro de cada campo. El texto se actualiza al instante sobre la página.";
      panelBody.appendChild(note);
    } else {
      const patched = imagePatches.get(selector);
      const preview = document.createElement("img");
      preview.className = "image-preview";
      preview.src = element.getAttribute("src") || element.currentSrc || "";
      preview.alt = "Vista previa de la imagen seleccionada";
      panelBody.appendChild(preview);

      const drop = document.createElement("label");
      drop.className = "image-drop";
      drop.textContent = "Arrastra una imagen o pulsa para seleccionarla";
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = ".png,.jpg,.jpeg,.webp,.gif,.avif,image/png,image/jpeg,image/webp,image/gif,image/avif";
      fileInput.setAttribute("aria-label", "Seleccionar imagen de sustitución");
      drop.appendChild(fileInput);
      fileInput.addEventListener("change", () => {
        if (fileInput.files?.[0]) replaceImage(fileInput.files[0]);
      });
      drop.addEventListener("dragover", event => {
        event.preventDefault();
        drop.classList.add("dragging");
      });
      drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
      drop.addEventListener("drop", event => {
        event.preventDefault();
        drop.classList.remove("dragging");
        const file = [...(event.dataTransfer?.files || [])].find(item => acceptedImageTypes.has(item.type));
        if (file) replaceImage(file);
      });
      panelBody.appendChild(drop);

      const alt = createField("Texto alternativo (accesibilidad)", element.getAttribute("alt") || "", { multiline: true });
      let captured = false;
      alt.control.addEventListener("focus", () => {
        if (!captured) {
          storeSnapshot();
          captured = true;
        }
      });
      alt.control.addEventListener("input", () => updateImageAlt(alt.control.value));
      panelBody.appendChild(alt.wrapper);

      const info = document.createElement("p");
      info.className = "hint";
      info.textContent = patched?.filename
        ? "Borrador: " + patched.filename + ". La imagen no se ha enviado al servidor."
        : "Original: " + (element.getAttribute("src") || "").split("/").pop();
      panelBody.appendChild(info);

      if (patched?.dataUrl) {
        const download = document.createElement("button");
        download.type = "button";
        download.className = "secondary-action";
        download.textContent = "Descargar imagen sustituida";
        download.addEventListener("click", () => downloadUrl(patched.dataUrl, patched.filename || "image.png"));
        panelBody.appendChild(download);
      }
    }

    // Element notes are independent of changes to text or images: a note alone
    // is a valid draft and appears in JSON, Codex instructions and HTML exports.
    const notesContainer = document.createElement("div");
    notesContainer.className = "notes-section";
    const existingNote = notePatches.get(selector);
    const noteField = createField("Comentarios / notas (opcional)", existingNote?.note || "", { multiline: true });
    noteField.control.rows = 4;
    noteField.control.maxLength = 4000;
    noteField.control.placeholder = "Por ejemplo: Cambiar el tono del titular, sustituir esta captura o revisar el texto con Codex…";
    let capturedNote = false;
    noteField.control.addEventListener("focus", () => {
      if (!capturedNote) {
        storeSnapshot();
        capturedNote = true;
      }
    });
    noteField.control.addEventListener("input", () => updateNote(selector, noteField.control.value));
    notesContainer.appendChild(noteField.wrapper);
    const help = document.createElement("p");
    help.className = "hint";
    help.textContent = "Puedes dejar una indicación sin modificar el contenido. Se guarda como borrador y se incluye en todas las exportaciones.";
    notesContainer.appendChild(help);
    panelBody.appendChild(notesContainer);

    const locator = document.createElement("p");
    locator.className = "locator";
    locator.textContent = "Selector: " + selector;
    panelBody.appendChild(locator);
  }

  function captureState() {
    return {
      text: [...textPatches.values()].map(patch => ({ ...patch })),
      images: [...imagePatches.values()].map(patch => ({ ...patch })),
      notes: [...notePatches.values()].map(patch => ({ ...patch }))
    };
  }

  function resetElementsToOriginal() {
    textPatches.forEach(patch => {
      const element = lookupElement(patch.selector);
      const node = element && textNodesFor(element)[patch.nodeIndex];
      if (node) node.nodeValue = patch.original;
    });
    imagePatches.forEach(patch => {
      const image = lookupElement(patch.selector);
      if (!(image instanceof HTMLImageElement)) return;
      image.setAttribute("src", patch.originalSrc);
      image.setAttribute("alt", patch.originalAlt);
    });
  }

  function applyCurrentState() {
    let stale = 0;
    textPatches.forEach(patch => {
      const element = lookupElement(patch.selector);
      const node = element && textNodesFor(element)[patch.nodeIndex];
      if (!node) {
        stale++;
        return;
      }
      if (node.nodeValue !== patch.original && node.nodeValue !== patch.value) {
        stale++;
        return;
      }
      if (node.nodeValue !== patch.value) node.nodeValue = patch.value;
    });
    imagePatches.forEach(patch => {
      const image = lookupElement(patch.selector);
      if (!(image instanceof HTMLImageElement)) {
        stale++;
        return;
      }
      if (image.getAttribute("src") !== patch.originalSrc &&
          image.getAttribute("src") !== patch.dataUrl) {
        stale++;
        return;
      }
      if (image.getAttribute("alt") !== patch.alt) image.setAttribute("alt", patch.alt);
      if (patch.dataUrl && image.getAttribute("src") !== patch.dataUrl) image.setAttribute("src", patch.dataUrl);
    });
    return stale;
  }

  function restoreState(snapshot) {
    resetElementsToOriginal();
    textPatches = new Map(snapshot.text.map(patch => [textKey(patch.selector, patch.nodeIndex), { ...patch }]));
    imagePatches = new Map(snapshot.images.map(patch => [patch.selector, { ...patch }]));
    notePatches = new Map((snapshot.notes || []).map(patch => [patch.selector, { ...patch }]));
    applyCurrentState();
    persistDraft();
    refreshToolbar();
    if (selected) renderInspector();
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(captureState());
    restoreState(undoStack.pop());
    notify("Última edición deshecha.");
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(captureState());
    restoreState(redoStack.pop());
    notify("Edición recuperada.");
  }

  function setEditing(active) {
    editing = !!active;
    page.classList.toggle("acve-editing", editing);
    if (!editing) {
      setHovered(null);
      setSelected(null);
    } else {
      exportPanel.hidden = true;
      notify("Edición activada: haz clic en cualquier texto o imagen.");
    }
    refreshToolbar();
  }

  async function hydrateImageDrafts() {
    for (const patch of imagePatches.values()) {
      if (!patch.filename) continue;
      try {
        const entry = await readImageAsset(imageKey(patch.selector));
        if (!entry?.dataUrl) continue;
        if (!imagePatches.has(patch.selector)) continue;
        const current = imagePatches.get(patch.selector);
        const image = lookupElement(patch.selector);
        if (!(image instanceof HTMLImageElement) || image.getAttribute("src") !== patch.originalSrc) continue;
        const hydrated = { ...current, dataUrl: entry.dataUrl };
        imagePatches.set(patch.selector, hydrated);
        image.setAttribute("src", entry.dataUrl);
        image.setAttribute("alt", hydrated.alt);
      } catch {
        notify("Una imagen del borrador no ha podido recuperarse. Puedes sustituirla otra vez.");
      }
    }
    refreshToolbar();
  }

  function restoreDraft() {
    let parsed;
    try {
      parsed = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    } catch {
      return;
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.text) || !Array.isArray(parsed.images)) return;
    let stale = 0;
    staleDraft = { text: [], images: [], notes: [] };
    for (const patch of parsed.text) {
      if (typeof patch.selector !== "string" || !Number.isInteger(patch.nodeIndex) ||
          typeof patch.original !== "string" || typeof patch.value !== "string") continue;
      const element = lookupElement(patch.selector);
      const node = element && textNodesFor(element)[patch.nodeIndex];
      if (!node || (node.nodeValue !== patch.original && node.nodeValue !== patch.value)) {
        stale++;
        staleDraft.text.push(patch);
        continue;
      }
      // The source file may already contain the edited value after a merge.
      // In that case the edit is fulfilled; do not retain a patch that could
      // erroneously revert canonical source when the user presses Reset.
      if (node.nodeValue === patch.value && node.nodeValue !== patch.original) continue;
      textPatches.set(textKey(patch.selector, patch.nodeIndex), patch);
      node.nodeValue = patch.value;
    }
    for (const patch of parsed.images) {
      if (typeof patch.selector !== "string" || typeof patch.originalSrc !== "string" ||
          typeof patch.alt !== "string") continue;
      const image = lookupElement(patch.selector);
      if (!(image instanceof HTMLImageElement) || image.getAttribute("src") !== patch.originalSrc) {
        stale++;
        staleDraft.images.push(patch);
        continue;
      }
      if (!patch.filename && image.getAttribute("alt") === patch.alt &&
          image.getAttribute("alt") !== patch.originalAlt) continue;
      imagePatches.set(patch.selector, patch);
      image.setAttribute("alt", patch.alt);
    }
    // Notes restore independently and are kept for manual review if the
    // selected element's tag or text/image context has changed in the source.
    for (const patch of Array.isArray(parsed.notes) ? parsed.notes : []) {
      if (typeof patch.selector !== "string" || typeof patch.note !== "string" ||
          typeof patch.context !== "string" || typeof patch.tag !== "string") continue;
      const element = lookupElement(patch.selector);
      if (!element || element.tagName.toLowerCase() !== patch.tag ||
          elementNoteContext(element, patch.selector) !== patch.context) {
        stale++;
        staleDraft.notes.push(patch);
        continue;
      }
      if (patch.note.trim()) notePatches.set(patch.selector, { ...patch });
    }
    if (imagePatches.size) hydrateImageDrafts();
    if (stale) notify(stale + " cambios no se han aplicado: el HTML ha cambiado desde el borrador. Exporta y revisa los originales.");
    persistDraft();
    refreshToolbar();
  }

  function manifest() {
    return {
      editor: "AC Visual Lab Editor",
      version: 1,
      generatedAt: new Date().toISOString(),
      sourcePage: pagePath,
      text: [...textPatches.values()],
      images: [...imagePatches.values()].map(({ dataUrl, ...patch }) => ({
        ...patch,
        exportHint: patch.filename
          ? "Download the replaced image from its inspector or use the reference HTML containing the embedded file."
          : "Alt text only"
      })),
      notes: [...notePatches.values()].map(patch => ({ ...patch })),
      unapplied: {
        text: [...staleDraft.text],
        images: [...staleDraft.images],
        notes: [...staleDraft.notes]
      }
    };
  }

  function codexInstructions() {
    const changed = manifest();
    const result = [
      "AC VISUAL LAB EDITOR — CAMBIOS PARA CODEX",
      "",
      "Página: " + changed.sourcePage,
      "Repositorio de referencia: acancelas/alejandrocancelas-lab",
      "",
      "Aplica estos cambios sobre el CÓDIGO FUENTE. Conserva HTML semántico, diseño,",
      "marcas, estilos, accesibilidad, SEO y la seguridad del despliegue.",
      "Trabaja en una rama, valida enlaces y recursos, y abre una Pull Request.",
      "Los selectores describen la versión de la página desde la que se editó;",
      "comprueba que el texto original coincide antes de reemplazar nada.",
      "",
      "TEXTOS"
    ];
    if (!changed.text.length) result.push("- No hay textos modificados.");
    for (const item of changed.text) {
      result.push(
        "- Selector: " + item.selector,
        "  Nodo de texto: " + item.nodeIndex,
        "  Original: " + JSON.stringify(item.original),
        "  Nuevo: " + JSON.stringify(item.value)
      );
    }
    result.push("", "IMÁGENES");
    if (!changed.images.length) result.push("- No hay imágenes modificadas.");
    for (const item of changed.images) {
      result.push(
        "- Selector: " + item.selector,
        "  Original src: " + item.originalSrc,
        "  Nuevo archivo: " + (item.filename || "(sin nuevo archivo; solo alt)"),
        "  Nuevo alt: " + JSON.stringify(item.alt),
        "  Guardar nueva imagen en el repositorio y usar una URL local al publicarla."
      );
    }
    result.push("", "COMENTARIOS / NOTAS POR ELEMENTO");
    if (!changed.notes.length) result.push("- No hay notas.");
    for (const item of changed.notes) {
      result.push(
        "- Selector: " + item.selector,
        "  Tipo de elemento: " + item.tag,
        "  Contexto original: " + JSON.stringify(item.context),
        "  Nota: " + JSON.stringify(item.note)
      );
    }
    if (changed.unapplied.text.length || changed.unapplied.images.length ||
        changed.unapplied.notes.length) {
      result.push("", "BORRADOR ANTERIOR NO APLICADO (HTML CAMBIADO)");
      for (const item of changed.unapplied.text) {
        result.push("- Texto anterior en: " + item.selector,
          "  Original: " + JSON.stringify(item.original),
          "  Propuesta: " + JSON.stringify(item.value));
      }
      for (const item of changed.unapplied.images) {
        result.push("- Imagen anterior en: " + item.selector + " -> " + (item.filename || "solo texto alternativo"));
      }
      for (const item of changed.unapplied.notes) {
        result.push(
          "- Nota pendiente en: " + item.selector,
          "  Contexto: " + JSON.stringify(item.context),
          "  Nota: " + JSON.stringify(item.note)
        );
      }
      result.push("Estos cambios y notas no se aplicaron automáticamente; reconciliarlos con el código actualizado.");
    }
    result.push(
      "", "IMPORTANTE",
      "- Las notas son indicaciones editoriales asociadas a elementos, incluso si no se editó su contenido.",
      "- El editor solo genera borradores locales y exportaciones; no ha realizado commits.",
      "- Las imágenes se exportan incrustadas en el HTML de referencia.",
      "- Para producción, extrae los assets al repositorio y no utilices un data URI gigante.",
      "- Verifica visualmente escritorio y móvil antes de fusionar."
    );
    return result.join("\n");
  }

  function htmlSource() {
    const cloned = document.documentElement.cloneNode(true);
    cloned.querySelector("#acve-root")?.remove();
    cloned.querySelector("#acve-outline-style")?.remove();
    cloned.querySelectorAll("script[data-ac-lab-editor]").forEach(element => element.remove());
    cloned.querySelectorAll(".acve-hover,.acve-selected").forEach(element => {
      element.classList.remove("acve-hover", "acve-selected");
    });
    cloned.querySelector(rootSelector)?.classList.remove("acve-editing");
    cloned.classList.remove("js-motion");
    // Portable HTML export: editorial notes are serialized as safe HTML
    // comments adjacent to their elements, not as visible page content.
    const annotate = (patch, isStale = false) => {
      const note = String(patch.note || "").replace(/--/g, "- -").replace(/\u0000/g, "");
      if (!note.trim()) return;
      const comment = document.createComment(
        " AC VISUAL LAB EDITOR NOTE" + (isStale ? " (UNAPPLIED: SOURCE CHANGED)" : "") +
        "\nElement: " + patch.selector + "\nComment: " + note + "\n "
      );
      let element = null;
      try { element = cloned.querySelector(patch.selector); } catch { /* Invalid selector */ }
      if (!isStale && element?.parentNode) element.parentNode.insertBefore(comment, element);
      else (cloned.querySelector(rootSelector) || cloned).appendChild(comment);
    };
    notePatches.forEach(patch => annotate(patch));
    staleDraft.notes.forEach(patch => annotate(patch, true));
    return "<!doctype html>\n" + cloned.outerHTML;
  }

  function downloadText(data, filename, mime = "text/plain;charset=utf-8") {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    downloadUrl(url, filename);
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function downloadUrl(url, filename) {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch { /* Fallback for browsers without clipboard permissions. */ }
    }
    const field = document.createElement("textarea");
    field.value = value;
    field.style.cssText = "position:fixed;top:-2000px;left:-2000px";
    document.body.appendChild(field);
    field.select();
    const success = document.execCommand("copy");
    field.remove();
    if (!success) throw new Error("Clipboard denied");
  }

  function openExport() {
    editPanel.hidden = true;
    exportPanel.hidden = false;
    codePreview.hidden = true;
    notify("Los cambios son locales: exporta las modificaciones antes de publicarlas.");
  }

  async function runExport(action) {
    if (action === "instructions") {
      await copyText(codexInstructions());
      notify("Instrucciones para Codex copiadas.");
    } else if (action === "manifest") {
      downloadText(JSON.stringify(manifest(), null, 2), "visual-lab-changes.json", "application/json;charset=utf-8");
      notify("Manifest de cambios descargado.");
    } else if (action === "html-copy") {
      await copyText(htmlSource());
      notify("HTML completo copiado. Las imágenes nuevas van incrustadas.");
    } else if (action === "html-download") {
      downloadText(htmlSource(), pagePath.split("/").pop().replace(/\.html?$/i, "") + "-edited.html", "text/html;charset=utf-8");
      notify("HTML de referencia descargado.");
    } else if (action === "html-show") {
      codePreview.value = htmlSource();
      codePreview.hidden = false;
      codePreview.focus();
      codePreview.select();
      notify("Código seleccionado: puedes usar Ctrl/Cmd + A, C o V en tu editor.");
    }
  }

  async function clearAll() {
    if (!window.confirm("¿Descartar todos los cambios locales de esta página? Esta acción no puede deshacerse tras recargar.")) return;
    const imageSelectors = [...imagePatches.keys(), ...staleDraft.images.map(patch => patch.selector)];
    storeSnapshot();
    resetElementsToOriginal();
    textPatches.clear();
    imagePatches.clear();
    notePatches.clear();
    staleDraft = { text: [], images: [], notes: [] };
    for (const selector of imageSelectors) await deleteImageAsset(imageKey(selector));
    persistDraft();
    refreshToolbar();
    if (selected) renderInspector();
    notify("Borrador restaurado a su estado original.");
  }

  page.addEventListener("mouseover", event => {
    if (!editing) return;
    setHovered(editableFromEvent(event));
  });
  page.addEventListener("mouseleave", () => {
    if (editing) setHovered(null);
  });
  page.addEventListener("click", event => {
    if (!editing) return;
    const candidate = editableFromEvent(event);
    if (!candidate) return;
    event.preventDefault();
    event.stopPropagation();
    setSelected(candidate);
  }, true);

  page.addEventListener("dragover", event => {
    if (editing && event.target instanceof Element && event.target.closest("img")) event.preventDefault();
  }, true);
  page.addEventListener("drop", event => {
    if (!editing) return;
    const image = event.target instanceof Element ? event.target.closest("img") : null;
    if (!image || !page.contains(image)) return;
    event.preventDefault();
    const file = [...(event.dataTransfer?.files || [])].find(item => acceptedImageTypes.has(item.type));
    if (file) {
      setSelected(image);
      replaceImage(file);
    }
  }, true);

  document.addEventListener("paste", event => {
    if (!editing || selected?.type !== "image") return;
    const target = event.target;
    if (target instanceof Element && (target.closest("textarea,input,[contenteditable=true]"))) return;
    const file = [...(event.clipboardData?.files || [])].find(item => acceptedImageTypes.has(item.type));
    if (!file) return;
    event.preventDefault();
    replaceImage(file);
  }, true);

  toggleButton.addEventListener("click", () => setEditing(!editing));
  undoButton.addEventListener("click", undo);
  redoButton.addEventListener("click", redo);
  exportButton.addEventListener("click", openExport);
  $("acve-close").addEventListener("click", () => setSelected(null));
  $("acve-export-close").addEventListener("click", () => { exportPanel.hidden = true; if (editing && selected) editPanel.hidden = false; });
  $("acve-save").addEventListener("click", () => {
    if (persistDraft()) notify("Borrador guardado solo en este navegador. GitHub sigue sin cambios.");
  });
  $("acve-reset").addEventListener("click", clearAll);

  shadow.querySelectorAll("[data-export-action]").forEach(button => {
    button.addEventListener("click", () => {
      runExport(button.dataset.exportAction).catch(() => notify("No se pudo copiar. Prueba con Seleccionar código HTML."));
    });
  });

  document.addEventListener("keydown", event => {
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === "e") {
      event.preventDefault();
      setEditing(!editing);
    }
    if (!editing || !(event.metaKey || event.ctrlKey)) return;
    if (event.key.toLowerCase() !== "z") return;
    const target = event.target;
    if (target instanceof Element && (target.closest("input,textarea,[contenteditable=true]") ||
      shadow.contains(target))) return;
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
  }, true);

  // Per-route drafts: BOS uses hash navigation; React Router notifies this
  // module after a route has mounted. No page or data is sent anywhere.
  function switchRouteIfChanged() {
    const next = currentPageKey();
    if (next === pagePath) return;
    persistDraft();
    setHovered(null);
    setSelected(null);
    textPatches = new Map();
    imagePatches = new Map();
    notePatches = new Map();
    staleDraft = { text: [], images: [], notes: [] };
    undoStack = [];
    redoStack = [];
    pagePath = next;
    storageKey = "ac-visual-lab-editor:v1:" + pagePath;
    restoreDraft();
    refreshToolbar();
  }
  window.addEventListener("hashchange", () => window.requestAnimationFrame(switchRouteIfChanged));
  window.addEventListener("popstate", () => window.requestAnimationFrame(switchRouteIfChanged));
  window.addEventListener("acve-route-change", () => window.requestAnimationFrame(switchRouteIfChanged));

  // SPA preview adapter: React or a hash-driven lab may replace DOM nodes
  // while retaining the root container. Re-apply ONLY if the original text
  // still matches. Avoid endless mutation loops by not writing equal values.
  if (spaMode && "MutationObserver" in window) {
    let waiting = false;
    const observer = new MutationObserver(() => {
      if (waiting) return;
      waiting = true;
      window.requestAnimationFrame(() => {
        waiting = false;
        if (currentPageKey() !== pagePath) {
          switchRouteIfChanged();
          return;
        }
        if (selected?.element && !page.contains(selected.element)) setSelected(null);
        applyCurrentState();
      });
    });
    observer.observe(page, { childList: true, subtree: true, characterData: true });
  }

  restoreDraft();
  refreshToolbar();
})();