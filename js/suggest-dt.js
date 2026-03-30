import { app } from "../../scripts/app.js";

const STYLE_ID = "suggest-dt-styles";
const MAX_SUGGESTIONS = 20;

// ── CSV parser (handles quoted fields) ───────────────────────────────────────

function parseCSVLine(line) {
    const cols = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQ = !inQ; }
        else if (c === "," && !inQ) { cols.push(cur); cur = ""; }
        else { cur += c; }
    }
    cols.push(cur);
    return cols;
}

// ── Tag data (danbooru.csv: name,category,count,"aliases") ───────────────────

// { text, category, count, aliases: string[] }
let tags = [];

async function loadTags() {
    try {
        const resp = await fetch("/suggest-dt/tags");
        if (!resp.ok) return;
        const csv = await resp.text();
        tags = [];
        for (const line of csv.split("\n")) {
            if (!line.trim()) continue;
            const [text, catStr, cntStr, aliasStr] = parseCSVLine(line);
            if (!text) continue;
            const category = parseInt(catStr, 10);
            const count = parseInt(cntStr, 10) || 0;
            const aliases = aliasStr
                ? aliasStr.split(",").map(a => a.trim()).filter(Boolean)
                : [];
            tags.push({ text, category: isNaN(category) ? 0 : category, count, aliases });
        }
        console.log(`[suggest-dt] Loaded ${tags.length} danbooru tags`);
    } catch (e) {
        console.warn("[suggest-dt] Failed to load tags:", e);
    }
}

function getTagMatches(query) {
    if (!query || tags.length === 0) return [];
    const q = query.toLowerCase();
    const prefix = [];
    const includes = [];
    for (const tag of tags) {
        const t = tag.text.toLowerCase();
        const aliasPrefix = tag.aliases.some(a => a.toLowerCase().startsWith(q));
        const aliasInc   = tag.aliases.some(a => a.toLowerCase().includes(q));
        if (t === q) continue;
        if (t.startsWith(q) || aliasPrefix) prefix.push(tag);
        else if (t.includes(q) || aliasInc)  includes.push(tag);
        if (prefix.length + includes.length >= MAX_SUGGESTIONS * 4) break;
    }
    prefix.sort((a, b) => b.count - a.count);
    includes.sort((a, b) => b.count - a.count);
    return [...prefix, ...includes].slice(0, MAX_SUGGESTIONS);
}

// ── File source data ──────────────────────────────────────────────────────────

let fileEntries = []; // { name, prefix, suffix }

async function loadFileEntries() {
    try {
        const resp = await fetch("/suggest-dt/files");
        if (!resp.ok) return;
        fileEntries = await resp.json();
        console.log(`[suggest-dt] Loaded ${fileEntries.length} file entries`);
    } catch (e) {
        console.warn("[suggest-dt] Failed to load file entries:", e);
    }
}

function getFileMatches(word) {
    if (fileEntries.length === 0) return null;
    let bestPrefix = null;
    for (const e of fileEntries) {
        if (e.prefix && word.startsWith(e.prefix)) {
            if (bestPrefix === null || e.prefix.length > bestPrefix.length)
                bestPrefix = e.prefix;
        }
    }
    if (bestPrefix === null) return null;
    const q = word.slice(bestPrefix.length).toLowerCase();
    const matched = fileEntries
        .filter(e => e.prefix === bestPrefix && e.name.toLowerCase().includes(q))
        .slice(0, MAX_SUGGESTIONS);
    if (matched.length === 0) return null;
    return matched.map(e => ({ text: e.prefix + e.name + e.suffix, label: e.name, count: 0 }));
}

// ── Danbooru wiki tooltip ─────────────────────────────────────────────────────

const wikiCache = new Map(); // tag → stripped body string | null (not found)
let wikiTimer = null;

const wikiTooltip = (() => {
    const el = document.createElement("div");
    el.className = "suggest-dt-wiki-tooltip";
    el.style.display = "none";
    document.body.appendChild(el);
    return el;
})();

// Strips Danbooru's DText markup to readable plain text.
function stripDText(body) {
    return body
        // [[link|display]] or [[link]]
        .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, link, display) => display || link)
        // {{template}}
        .replace(/\{\{[^}]+\}\}/g, "")
        // [b]...[/b] etc. — keep inner text
        .replace(/\[(?:b|i|u|s|color=[^\]]*|spoiler|expand(?:=[^\]]*)?)\]([\s\S]*?)\[\/[^\]]+\]/gi, "$1")
        // h1. heading → just the text
        .replace(/^h[1-6]\.\s*/gm, "")
        // list bullets
        .replace(/^\*+\s*/gm, "• ")
        // bare URLs
        .replace(/https?:\/\/\S+/g, "")
        // collapse excess blank lines
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function positionWikiTooltip(anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const margin = 6;
    wikiTooltip.style.display = "block";
    const tw = wikiTooltip.offsetWidth;
    const th = wikiTooltip.offsetHeight;

    // Prefer: right of the dropdown button
    let x = rect.right + margin;
    if (x + tw > window.innerWidth - margin) {
        // Flip: left of the button
        x = rect.left - tw - margin;
    }
    let y = rect.top;
    if (y + th > window.innerHeight - margin) y = window.innerHeight - th - margin;

    wikiTooltip.style.left = `${Math.max(margin, x)}px`;
    wikiTooltip.style.top  = `${Math.max(margin, y)}px`;
}

function showWikiTooltip(tag, anchorEl) {
    clearTimeout(wikiTimer);
    wikiTimer = setTimeout(async () => {
        if (wikiCache.has(tag)) {
            const body = wikiCache.get(tag);
            wikiTooltip.className = "suggest-dt-wiki-tooltip" + (body ? "" : " not-found");
            wikiTooltip.textContent = body ?? "No wiki page.";
            positionWikiTooltip(anchorEl);
            return;
        }

        wikiTooltip.className = "suggest-dt-wiki-tooltip loading";
        wikiTooltip.textContent = "Loading…";
        positionWikiTooltip(anchorEl);
        wikiTooltip.style.display = "block";

        try {
            const resp = await fetch(`/suggest-dt/wiki?tag=${encodeURIComponent(tag)}`);
            if (resp.status === 404) {
                wikiCache.set(tag, null);
                wikiTooltip.className = "suggest-dt-wiki-tooltip not-found";
                wikiTooltip.textContent = "No wiki page.";
            } else if (resp.ok) {
                const data = await resp.json();
                const stripped = stripDText(data.body || "");
                const preview = stripped.length > 320
                    ? stripped.slice(0, 320) + "…"
                    : stripped || "(empty)";
                wikiCache.set(tag, preview);
                wikiTooltip.className = "suggest-dt-wiki-tooltip";
                wikiTooltip.textContent = preview;
            } else {
                wikiTooltip.className = "suggest-dt-wiki-tooltip not-found";
                wikiTooltip.textContent = "Failed to load.";
            }
        } catch {
            wikiTooltip.className = "suggest-dt-wiki-tooltip not-found";
            wikiTooltip.textContent = "Failed to load.";
        }
        positionWikiTooltip(anchorEl);
    }, 420);
}

function hideWikiTooltip() {
    clearTimeout(wikiTimer);
    wikiTooltip.style.display = "none";
}

// ── Caret coordinate helper ───────────────────────────────────────────────────

function getCaretRect(el) {
    const computed = window.getComputedStyle(el);
    const elRect = el.getBoundingClientRect();

    const outer = document.createElement("div");
    outer.style.cssText = [
        "position:fixed",
        `top:${elRect.top}px`,
        `left:${elRect.left}px`,
        `width:${el.clientWidth}px`,
        `height:${el.clientHeight}px`,
        "visibility:hidden", "overflow:hidden", "pointer-events:none", "z-index:-1",
    ].join(";");

    const inner = document.createElement("div");
    inner.style.cssText = [
        "position:relative", "white-space:pre-wrap", "word-break:break-word",
        `margin-top:-${el.scrollTop}px`,
    ].join(";");
    for (const p of [
        "fontFamily", "fontSize", "fontWeight", "fontStyle",
        "letterSpacing", "lineHeight",
        "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth",
    ]) inner.style[p] = computed[p];

    inner.textContent = el.value.slice(0, el.selectionEnd);
    const span = document.createElement("span");
    span.textContent = "\u200b";
    inner.appendChild(span);
    outer.appendChild(inner);
    document.body.appendChild(outer);

    const spanRect = span.getBoundingClientRect();
    document.body.removeChild(outer);

    return {
        x: Math.max(elRect.left + 4, Math.min(spanRect.left, elRect.right - 4)),
        y: Math.min(spanRect.bottom, elRect.bottom),
        elRect,
    };
}

// ── Dropdown UI ───────────────────────────────────────────────────────────────

class Dropdown {
    constructor() {
        this.el = document.createElement("div");
        this.el.className = "suggest-dt-dropdown";
        this.el.style.display = "none";
        document.body.appendChild(this.el);

        this.items = [];
        this.activeIndex = -1;
        this.onSelect = null;

        // mousedown on the item body (not wiki button) selects the tag
        this.el.addEventListener("mousedown", (e) => {
            if (e.target.classList.contains("suggest-dt-wiki")) return; // let link handle it
            e.preventDefault();
            const item = e.target.closest(".suggest-dt-item");
            if (item) this.onSelect?.(this.items[parseInt(item.dataset.idx, 10)].text);
        });
    }

    show(matches, rect, onSelect) {
        this.items = matches;
        this.activeIndex = matches.length > 0 ? 0 : -1;
        this.onSelect = onSelect;
        this.render();

        this.el.style.left = "0px";
        this.el.style.top  = "0px";
        this.el.style.display = "block";

        const vw = window.innerWidth, vh = window.innerHeight;
        const dw = this.el.offsetWidth,  dh = this.el.offsetHeight;
        const m  = 4;

        let x = rect.x;
        let y = rect.y;

        if (x + dw > vw - m) x = vw - dw - m;
        x = Math.max(rect.elRect.left, Math.min(x, rect.elRect.right - dw));
        x = Math.max(m, x);

        if (y + dh > vh - m) {
            const lh = parseFloat(window.getComputedStyle(document.body).lineHeight) || 18;
            y = rect.y - lh - dh;
        }
        y = Math.max(m, y);

        this.el.style.left = `${x}px`;
        this.el.style.top  = `${y}px`;
    }

    hide() {
        this.el.style.display = "none";
        this.items = [];
        this.activeIndex = -1;
        hideWikiTooltip();
    }

    isVisible() { return this.el.style.display !== "none"; }

    render() {
        this.el.innerHTML = "";
        for (let i = 0; i < this.items.length; i++) {
            const item = this.items[i];
            const row = document.createElement("div");
            row.className = "suggest-dt-item" + (i === this.activeIndex ? " active" : "");
            if (item.category !== undefined) row.classList.add(`suggest-dt-cat-${item.category}`);
            row.dataset.idx = i;

            const name = document.createElement("span");
            name.className = "suggest-dt-name";
            name.textContent = item.label ?? item.text;

            const cnt = document.createElement("span");
            cnt.className = "suggest-dt-count";
            cnt.textContent = item.count > 0 ? item.count.toLocaleString() : "";

            row.appendChild(name);
            row.appendChild(cnt);

            // Wiki button only for danbooru tags
            if (item.category !== undefined) {
                const wikiBtn = document.createElement("a");
                wikiBtn.className = "suggest-dt-wiki";
                wikiBtn.textContent = "?";
                wikiBtn.title = "Danbooru wiki";
                wikiBtn.href = `https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(item.text)}`;
                wikiBtn.target = "_blank";
                wikiBtn.rel = "noopener noreferrer";
                wikiBtn.addEventListener("mouseenter", () => showWikiTooltip(item.text, wikiBtn));
                wikiBtn.addEventListener("mouseleave", hideWikiTooltip);
                row.appendChild(wikiBtn);
            }

            this.el.appendChild(row);
        }
    }

    moveActive(delta) {
        if (!this.items.length) return;
        this.activeIndex = (this.activeIndex + delta + this.items.length) % this.items.length;
        this.render();
        this.el.children[this.activeIndex]?.scrollIntoView({ block: "nearest" });
    }

    getActiveText() {
        return this.activeIndex >= 0 ? this.items[this.activeIndex]?.text ?? null : null;
    }
}

// ── Autocomplete controller ───────────────────────────────────────────────────

const dropdown = new Dropdown();

function getCurrentWord(textarea) {
    const val = textarea.value;
    const pos = textarea.selectionStart;
    let start = pos;
    while (start > 0 && !/[,\n]/.test(val[start - 1])) start--;
    while (start < pos && val[start] === " ") start++;
    return { word: val.slice(start, pos), start, end: pos };
}

function insertText(textarea, text, wordStart, wordEnd) {
    const val = textarea.value;
    const after = val.slice(wordEnd);
    const sep = after.trimStart().startsWith(",") ? "" : ", ";
    textarea.value = val.slice(0, wordStart) + text + sep + after;
    const pos = wordStart + text.length + sep.length;
    textarea.setSelectionRange(pos, pos);
    textarea.dispatchEvent(new Event("input",  { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

function attachAutocomplete(textarea) {
    if (textarea._suggestDtAttached) return;
    textarea._suggestDtAttached = true;

    textarea.addEventListener("input", () => {
        const { word, start, end } = getCurrentWord(textarea);
        if (word.length < 2) { dropdown.hide(); return; }

        const matches = getFileMatches(word) ?? getTagMatches(word);
        if (!matches.length) { dropdown.hide(); return; }

        const rect = getCaretRect(textarea);
        dropdown.show(matches, rect, (text) => {
            const { start: s, end: e } = getCurrentWord(textarea);
            insertText(textarea, text, s, e);
            dropdown.hide();
            textarea.focus();
        });
    });

    textarea.addEventListener("keydown", (e) => {
        if (!dropdown.isVisible()) return;
        if      (e.key === "ArrowDown") { e.preventDefault(); dropdown.moveActive(1); }
        else if (e.key === "ArrowUp")   { e.preventDefault(); dropdown.moveActive(-1); }
        else if (e.key === "Tab" || e.key === "Enter") {
            const text = dropdown.getActiveText();
            if (text) {
                e.preventDefault();
                const { start, end } = getCurrentWord(textarea);
                insertText(textarea, text, start, end);
                dropdown.hide();
            }
        } else if (e.key === "Escape") {
            dropdown.hide();
        }
    });

    textarea.addEventListener("blur", () => setTimeout(() => dropdown.hide(), 150));
}

// ── DOM observer ──────────────────────────────────────────────────────────────

function observeTextareas() {
    for (const el of document.querySelectorAll("textarea")) attachAutocomplete(el);
    new MutationObserver((mutations) => {
        for (const { addedNodes } of mutations) {
            for (const node of addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.tagName === "TEXTAREA") attachAutocomplete(node);
                else for (const el of node.querySelectorAll("textarea")) attachAutocomplete(el);
            }
        }
    }).observe(document.body, { childList: true, subtree: true });
}

// ── Settings dialog ───────────────────────────────────────────────────────────

async function openSourcesDialog() {
    let config = { sources: [] };
    try {
        const resp = await fetch("/suggest-dt/config");
        if (resp.ok) config = await resp.json();
    } catch (_) {}

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100000;display:flex;align-items:center;justify-content:center;";

    const dialog = document.createElement("div");
    dialog.style.cssText = "background:#1e1e1e;border:1px solid #555;border-radius:6px;padding:20px;width:580px;max-width:90vw;max-height:80vh;display:flex;flex-direction:column;gap:12px;color:#ddd;font-family:sans-serif;font-size:13px;";

    const title = document.createElement("div");
    title.textContent = "File Source Settings";
    title.style.cssText = "font-size:15px;font-weight:bold;color:#fff;";
    dialog.appendChild(title);

    const hint = document.createElement("div");
    hint.style.cssText = "color:#999;font-size:12px;";
    hint.textContent = "Typing the prefix in a text area will suggest filenames (without extension) from the folder, wrapped with the suffix.";
    dialog.appendChild(hint);

    const list = document.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;gap:8px;overflow-y:auto;max-height:320px;";
    dialog.appendChild(list);

    const headers = document.createElement("div");
    headers.style.cssText = "display:grid;grid-template-columns:1fr 90px 90px auto;gap:6px;color:#888;font-size:11px;";
    for (const h of ["Folder", "Prefix", "Suffix", ""]) {
        const s = document.createElement("span");
        s.textContent = h;
        headers.appendChild(s);
    }
    list.appendChild(headers);

    function makeRow(src = { folder: "", prefix: "__", suffix: "__" }) {
        const row = document.createElement("div");
        row.style.cssText = "display:grid;grid-template-columns:1fr 90px 90px auto;gap:6px;align-items:center;";
        const inp = (val, ph) => {
            const el = document.createElement("input");
            el.type = "text"; el.value = val; el.placeholder = ph;
            el.style.cssText = "background:#2a2a2a;border:1px solid #444;border-radius:3px;padding:4px 6px;color:#ddd;font-size:12px;width:100%;box-sizing:border-box;";
            return el;
        };
        const folderI = inp(src.folder, "Folder path");
        const prefixI = inp(src.prefix, "Prefix");
        const suffixI = inp(src.suffix, "Suffix");
        const del = document.createElement("button");
        del.textContent = "✕";
        del.style.cssText = "background:#5a2020;border:none;border-radius:3px;color:#f88;cursor:pointer;padding:4px 8px;font-size:12px;";
        del.onclick = () => row.remove();
        row._getData = () => ({ folder: folderI.value.trim(), prefix: prefixI.value, suffix: suffixI.value });
        row.append(folderI, prefixI, suffixI, del);
        return row;
    }

    for (const src of config.sources) list.appendChild(makeRow(src));

    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Add source";
    addBtn.style.cssText = "background:#1a3a1a;border:1px solid #3a6a3a;border-radius:3px;color:#8d8;cursor:pointer;padding:6px 12px;font-size:12px;align-self:flex-start;";
    addBtn.onclick = () => list.appendChild(makeRow());
    dialog.appendChild(addBtn);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:4px;";

    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText = "background:#333;border:1px solid #555;border-radius:3px;color:#ccc;cursor:pointer;padding:6px 16px;font-size:13px;";
    cancel.onclick = () => overlay.remove();

    const save = document.createElement("button");
    save.textContent = "Save";
    save.style.cssText = "background:#1a3a6a;border:1px solid #3a6aaa;border-radius:3px;color:#9cf;cursor:pointer;padding:6px 16px;font-size:13px;";
    save.onclick = async () => {
        const rows = [...list.children].filter(r => r._getData);
        const sources = rows.map(r => r._getData()).filter(s => s.folder);
        try {
            await fetch("/suggest-dt/config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sources }),
            });
            await loadFileEntries();
            overlay.remove();
        } catch (e) {
            alert("Failed to save: " + e.message);
        }
    };

    btnRow.append(cancel, save);
    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);
    overlay.addEventListener("mousedown", e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
}

// ── Extension registration ────────────────────────────────────────────────────

app.registerExtension({
    name: "suggest-dt.autocomplete",

    async setup() {
        if (!document.getElementById(STYLE_ID)) {
            const link = document.createElement("link");
            link.id = STYLE_ID;
            link.rel = "stylesheet";
            link.href = "/extensions/comfyui-suggest-dt/suggest-dt.css";
            document.head.appendChild(link);
        }

        loadTags();
        loadFileEntries();
        observeTextareas();

        app.ui.settings.addSetting({
            id: "suggest-dt.fileSources",
            name: "Danbooru Suggest: File Sources",
            type: (_name, _setter, _value) => {
                const btn = document.createElement("button");
                btn.textContent = "Configure File Sources…";
                btn.style.cssText = "padding:4px 12px;cursor:pointer;";
                btn.onclick = () => openSourcesDialog();
                return btn;
            },
            defaultValue: null,
        });
    },
});
