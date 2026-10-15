/* archivedownloader - front end. Plain JS, no build step.
   A port of The Ultimate Uzi Archive (uziarchive.top) by @flexbymistake,
   for any artist's tracker. */
(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const view = $("#view");
  const PAGE = 60;

  const state = {
    artists: [],           // the built-in list
    defaultArtist: "yeat",
    allowCustom: true,
    artist: null,          // the artist being shown (meta.artist)
    artistKey: "",
    meta: null,
    eras: new Map(),
    eraList: [],
    data: {},              // tab key -> items
    byId: new Map(),       // every loaded item by id
    filters: defaultFilters(),
    shown: PAGE,
    route: null
  };

  function defaultFilters() {
    return { q: "", status: "all", era: "", producer: "", type: "", available: "", quality: "", playable: false, notes: false, sort: "era" };
  }

  /* ---------- helpers ---------- */

  const esc = value => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const fold = value => String(value || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/\$/g, "s").toLowerCase();

  function hue(text) {
    let h = 0;
    for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }

  function coverHTML(era, label) {
    const name = era ? era.name : (label || "?");
    const h = hue(name);
    const list = era ? (era.covers && era.covers.length ? era.covers : era.cover ? [era.cover] : []) : [];
    const img = list.length
      ? `<img src="${esc(list[0])}" data-next="${esc(list.slice(1).join(" "))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="nextCover(this)">`
      : "";
    return `<div class="cover" style="--h:${h}"><div class="fallback">${esc(name)}</div>${img}</div>`;
  }

  // a dead cover link falls through to the next one, then to the era name
  window.nextCover = img => {
    const rest = (img.dataset.next || "").split(" ").filter(Boolean);
    if (!rest.length) return img.remove();
    img.dataset.next = rest.slice(1).join(" ");
    img.src = rest[0];
  };

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), 1800);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Link copied");
    } catch {
      prompt("Copy this link:", text);
    }
  }

  async function getJSON(url) {
    const response = await fetch(url);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  /* ---------- artists ---------- */

  // a page address for the artist being shown: "/" for the main one, "/uzi/era/x" for the rest
  function linkFor(artistKey, path = "/") {
    if (!artistKey || artistKey === state.defaultArtist) return path;
    return `/${artistKey}${path === "/" ? "" : path}`;
  }
  const L = path => linkFor(state.artistKey, path);
  const api = path => `/api/a/${encodeURIComponent(state.artistKey)}${path}`;

  const isArtistSegment = segment =>
    state.artists.some(a => a.key === segment) || /^sheet-[A-Za-z0-9_-]{25,80}$|^site-[a-z0-9.-]+$/.test(segment || "");

  // trackers this visitor added themselves, remembered in this browser only
  function savedTrackers() {
    try { return JSON.parse(localStorage.getItem("customTrackers") || "[]").filter(t => t && t.key && t.name); } catch { return []; }
  }
  function saveTracker(entry) {
    const list = savedTrackers().filter(t => t.key !== entry.key);
    list.unshift({ key: entry.key, name: entry.name });
    try { localStorage.setItem("customTrackers", JSON.stringify(list.slice(0, 12))); } catch { /* storage blocked */ }
  }
  function forgetTracker(key) {
    try { localStorage.setItem("customTrackers", JSON.stringify(savedTrackers().filter(t => t.key !== key))); } catch { /* storage blocked */ }
  }

  // an artist colour that still reads on the dark background
  function readableAccent(color, name) {
    const hex = String(color || "").match(/^#?([0-9a-f]{6})$/i);
    if (!hex) return `hsl(${hue(name || "x")} 80% 66%)`;
    let [r, g, b] = [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16));
    const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (light < 0.5) {
      const mix = Math.min(0.75, (0.55 - light) * 1.6);
      [r, g, b] = [r, g, b].map(v => Math.round(v + (255 - v) * mix));
    }
    return `rgb(${r} ${g} ${b})`;
  }

  function renderArtistBar() {
    const saved = savedTrackers().filter(t => !state.artists.some(a => a.key === t.key));
    const current = state.artistKey;
    const chip = (key, name, extra = "") =>
      `<a href="${linkFor(key, "/")}" data-link data-artist="${esc(key)}" ${key === current ? 'aria-current="page"' : ""} ${extra}>${esc(name)}</a>`;
    // a custom tracker opened from a shared link shows up even before it's saved
    const unsavedCurrent = current && !state.artists.some(a => a.key === current) && !saved.some(t => t.key === current) && state.artist
      ? [{ key: current, name: state.artist.name }] : [];
    $("#artists").innerHTML =
      state.artists.map(a => chip(a.key, a.name)).join("") +
      [...unsavedCurrent, ...saved].map(t => chip(t.key, t.name, 'class="custom"')).join("") +
      (state.allowCustom ? `<button type="button" class="add-btn" data-add-tracker aria-expanded="false">+ Any tracker</button>` : "");
    const active = $("#artists [aria-current]");
    if (active) $("#artists").scrollLeft = active.offsetLeft - ($("#artists").clientWidth - active.offsetWidth) / 2;
  }

  function addTrackerPanel() {
    const panel = $("#add-tracker");
    panel.innerHTML = `
      <form class="add-form" data-add-form>
        <label for="tracker-link">Paste any artist's tracker link</label>
        <div class="add-row">
          <input id="tracker-link" type="text" inputmode="url" autocomplete="off" spellcheck="false"
            placeholder="https://docs.google.com/spreadsheets/d/...">
          <button class="btn primary small" type="submit">Open</button>
        </div>
        <p class="add-note">Works with Google Sheets trackers that use the usual tracker layout (Unreleased / Released tabs). Only the tabs with songs and files get used; Recent, Best Of, Grails, Tracklists, Key and the rest are left out.</p>
        <p class="add-status" data-add-status role="status"></p>
        ${savedTrackers().length ? `<div class="saved"><span>Your trackers</span>${savedTrackers().map(t =>
          `<span class="saved-item"><a href="${linkFor(t.key, "/")}" data-link>${esc(t.name)}</a><button type="button" data-forget="${esc(t.key)}" aria-label="Remove ${esc(t.name)}">×</button></span>`).join("")}</div>` : ""}
      </form>`;
  }

  document.addEventListener("click", event => {
    if (event.target.closest("[data-add-tracker]")) {
      const panel = $("#add-tracker");
      panel.hidden = !panel.hidden;
      event.target.closest("[data-add-tracker]").setAttribute("aria-expanded", !panel.hidden);
      if (!panel.hidden) {
        addTrackerPanel();
        $("#tracker-link").focus();
      }
      return;
    }
    const forget = event.target.closest("[data-forget]");
    if (forget) {
      forgetTracker(forget.dataset.forget);
      addTrackerPanel();
      renderArtistBar();
    }
  });

  document.addEventListener("submit", async event => {
    const form = event.target.closest("[data-add-form]");
    if (!form) return;
    event.preventDefault();
    const link = $("#tracker-link").value.trim();
    const status = $("[data-add-status]", form);
    if (!link) return;
    status.textContent = "Reading the tracker... big ones can take up to a minute.";
    status.className = "add-status";
    form.querySelector("button[type=submit]").disabled = true;
    try {
      const found = await getJSON(`/api/resolve?link=${encodeURIComponent(link)}`);
      if (!found.builtIn) saveTracker(found);
      $("#add-tracker").hidden = true;
      go(linkFor(found.key, "/"));
    } catch (err) {
      status.textContent = err.message;
      status.className = "add-status error";
    } finally {
      form.querySelector("button[type=submit]").disabled = false;
    }
  });

  // switches the page over to another artist's tracker
  async function useArtist(key) {
    if (state.artistKey === key && state.meta) return;
    if (state.artistKey !== key) {
      state.artistKey = key;
      state.meta = null;
      state.data = {};
      state.byId = new Map();
      state.eras = new Map();
      state.eraList = [];
      state.filters = defaultFilters();
      state.shown = PAGE;
    }
    const known = state.artists.find(a => a.key === key) || savedTrackers().find(t => t.key === key);
    renderArtistBar();
    $("#tabs").innerHTML = "";
    view.innerHTML = `<div class="loading">Loading the ${esc(known ? known.name : "")} tracker...${known ? "" : " This can take a moment the first time."}</div>`;
    const meta = await getJSON(api("/meta"));
    if (state.artistKey !== key) return;
    state.meta = meta;
    state.artist = meta.artist;
    state.eraList = meta.eras;
    meta.eras.forEach(era => state.eras.set(era.key, era));
    document.documentElement.style.setProperty("--accent", readableAccent(meta.artist.accent, meta.artist.name));
    renderArtistBar();
    renderFooter();
  }

  function renderFooter() {
    const a = state.artist;
    if (!a) return;
    $("#foot-credits").innerHTML = `
      <h2>Credits</h2>
      <p class="credit-main">archivedownloader is a port of <a href="https://uziarchive.top" target="_blank" rel="noopener"><strong>The Ultimate Uzi Archive</strong></a> (uziarchive.top), the Lil Uzi Vert archive run by <strong>@flexbymistake</strong>. The idea, the layout and the features all come from that site. This is just the same thing remade to work with other artists' trackers. Go use the original.</p>
      <ul>
        <li>Original site and design: <a href="https://uziarchive.top" target="_blank" rel="noopener">uziarchive.top</a> by @flexbymistake</li>
        <li>Song data: the <a href="${esc(a.sheetUrl)}" target="_blank" rel="noopener">${esc(a.trackerName)}</a>${a.credits.length ? `, kept by ${esc(a.credits.join(", "))}` : ""}</li>
        <li>Files: hosted on pillows.su, pixeldrain, imgur.gg and other file hosts</li>
      </ul>
      <p class="credit-note">Everyone who made the original and keeps this tracker is on the <a href="${L("/credits")}" data-link>Credits page</a>. This port isn't made or run by @flexbymistake, so please don't send them problems with it.</p>`;
    $("#updated").textContent = `${a.trackerName} last synced ${new Date(state.meta.updatedAt).toLocaleString()}`;
  }

  async function loadTab(key) {
    if (state.data[key]) return state.data[key];
    const artistKey = state.artistKey;
    const items = await getJSON(api(`/tab/${key}`));
    if (artistKey !== state.artistKey) throw new Error("switched artist");
    items.forEach(item => {
      item.artist = artistKey;
      item.artistName = state.artist.name;
      item.eraObj = state.eras.get(item.era) || null;
      item.hay = fold([item.title, ...item.aliases, ...item.producers, ...item.features,
        item.eraObj ? item.eraObj.name : item.eraName, item.release, item.session, item.group, item.type].join(" "));
      item.noteHay = fold([item.notes, ...(item.fields || []).map(f => f.value)].join(" "));
      state.byId.set(item.id, item);
    });
    state.data[key] = items;
    return items;
  }

  const songTab = item => (item.section === "unreleased" || item.section === "released") ? "songs" : item.section;
  const tabLabel = key => (state.meta.tabs.find(tab => tab.key === key) || {}).label || key;

  /* ---------- routing ---------- */

  function parseRoute() {
    const parts = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const artist = isArtistSegment(parts[0]) ? parts.shift() : state.defaultArtist;
    const route = (() => {
      if (parts[0] === "era" && parts[1]) return { name: "era", era: parts[1], open: new URLSearchParams(location.search).get("song") };
      if (parts[0] === "song" && parts[1]) return { name: "song", id: parts[1] };
      if (parts[0] === "tab" && parts[1]) return { name: "tab", tab: parts[1] };
      if (parts[0] === "credits") return { name: "credits" };
      if (parts.length) return { name: "missing" };
      return { name: "tab", tab: "songs" };
    })();
    route.artist = artist;
    return route;
  }

  function go(url, { replace = false } = {}) {
    if (url === location.pathname + location.search) return;
    history[replace ? "replaceState" : "pushState"]({}, "", url);
    render();
  }

  document.addEventListener("click", event => {
    const link = event.target.closest("a[data-link]");
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || link.target === "_blank") return;
    event.preventDefault();
    go(link.getAttribute("href"));
  });

  window.addEventListener("popstate", render);

  /* ---------- tabs ---------- */

  function renderTabs(active) {
    $("#tabs").innerHTML = state.meta.tabs.map(tab =>
      `<a href="${L(tab.key === "songs" ? "/" : `/tab/${tab.key}`)}" data-link ${tab.key === active ? 'aria-current="page"' : ""}>${esc(tab.label)}</a>`
    ).join("") + `<a href="${L("/credits")}" data-link ${active === "credits" ? 'aria-current="page"' : ""}>Credits</a>`;
    const current = $("#tabs [aria-current]");
    if (current) $("#tabs").scrollLeft = current.offsetLeft - ($("#tabs").clientWidth - current.offsetWidth) / 2;
  }

  /* ---------- filtering ---------- */

  function filtersActive(tab) {
    const f = state.filters;
    if (tab !== "songs") return Boolean(f.q.trim() || f.era || f.playable);
    return Boolean(f.q.trim() || f.status !== "all" || f.era || f.producer || f.type || f.available || f.quality || f.playable);
  }

  function applyFilters(items, tab) {
    const f = state.filters;
    const words = fold(f.q).split(/\s+/).filter(Boolean);
    const producer = fold(f.producer);

    let out = items.filter(item => {
      if (tab === "songs" && f.status !== "all" && item.status !== f.status) return false;
      if (f.era && item.era !== f.era) return false;
      if (f.playable && !item.audio) return false;
      if (tab === "songs") {
        if (producer && !fold(item.producers.join(" ")).includes(producer)) return false;
        if (f.type && item.type !== f.type) return false;
        if (f.available && item.available !== f.available) return false;
        if (f.quality && item.quality !== f.quality) return false;
      }
      if (words.length) {
        const hay = f.notes ? item.hay + " " + item.noteHay : item.hay;
        if (!words.every(word => hay.includes(word))) return false;
      }
      return true;
    });

    if (f.sort === "title") out = out.slice().sort((a, b) => fold(a.title).localeCompare(fold(b.title)));
    if (f.sort === "newest") out = out.slice().reverse();
    return out;
  }

  function distinct(items, key) {
    const counts = new Map();
    items.forEach(item => item[key] && counts.set(item[key], (counts.get(item[key]) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value);
  }

  /* ---------- search header ---------- */

  function searchBlock(tab, items) {
    const f = state.filters;
    const chip = (value, label, color) =>
      `<button class="chip" type="button" data-status="${value}" aria-pressed="${f.status === value}">${color ? `<span class="dot" style="background:${color}"></span>` : ""}${label}</button>`;
    const option = (list, current) => list.map(value => `<option ${value === current ? "selected" : ""}>${esc(value)}</option>`).join("");
    const eraOptions = state.eraList.map(era => `<option value="${era.key}" ${era.key === f.era ? "selected" : ""}>${esc(era.name)}</option>`).join("");
    const showAdv = sessionStorageGet("adv") === "1";

    const songOnly = tab === "songs" ? `
      <label>Producer<input type="text" data-f="producer" value="${esc(f.producer)}" placeholder="e.g. BNYX"></label>
      <label>Type<select data-f="type"><option value="">Any</option>${option(distinct(items, "type"), f.type)}</select></label>
      <label>Available length<select data-f="available"><option value="">Any</option>${option(distinct(items, "available"), f.available)}</select></label>
      <label>Quality<select data-f="quality"><option value="">Any</option>${option(distinct(items, "quality"), f.quality)}</select></label>` : "";

    return `
      <div class="search">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="q" type="text" inputmode="search" enterkeyhint="search" autocomplete="off" spellcheck="false" value="${esc(f.q)}"
          placeholder="${tab === "songs" ? "Search songs, alt names, producers, features..." : `Search ${esc(tabLabel(tab).toLowerCase())}...`}">
        ${f.q ? '<button class="clear" type="button" data-clear>Clear</button>' : ""}
      </div>
      ${tab === "songs" ? `<div class="chips" role="group" aria-label="Status">
        ${chip("all", "All")}${chip("unreleased", "Unreleased", "var(--unreleased)")}${chip("released", "Released", "var(--released)")}${chip("unsurfaced", "Unsurfaced", "var(--unsurfaced)")}
      </div>` : ""}
      <button class="adv-toggle" type="button" data-adv aria-expanded="${showAdv}">Advanced search ${showAdv ? "▴" : "▾"}</button>
      <div class="advanced" ${showAdv ? "" : "hidden"}>
        <label>Era<select data-f="era"><option value="">All eras</option>${eraOptions}</select></label>
        ${songOnly}
        <label>Sort<select data-f="sort">
          <option value="era" ${f.sort === "era" ? "selected" : ""}>Tracker order</option>
          <option value="newest" ${f.sort === "newest" ? "selected" : ""}>Newest era first</option>
          <option value="title" ${f.sort === "title" ? "selected" : ""}>Title A-Z</option>
        </select></label>
        <label class="check"><input type="checkbox" data-f="playable" ${f.playable ? "checked" : ""}> Only playable files</label>
        <label class="check"><input type="checkbox" data-f="notes" ${f.notes ? "checked" : ""}> Also search notes</label>
        <button class="reset" type="button" data-reset>Reset filters</button>
      </div>`;
  }

  function sessionStorageGet(key) {
    try { return sessionStorage.getItem(key); } catch { return null; }
  }
  function sessionStorageSet(key, value) {
    try { sessionStorage.setItem(key, value); } catch { /* private mode */ }
  }

  /* ---------- tab page (home) ---------- */

  async function renderTab(tab) {
    if (!state.meta.tabs.some(t => t.key === tab)) return renderNotFound();
    renderTabs(tab);
    setEraColor(null);
    view.innerHTML = '<div class="loading">Loading the tracker...</div>';
    const items = await loadTab(tab);
    if (state.route.tab !== tab || state.route.name !== "tab") return;

    const heading = tab === "songs"
      ? `The <em>${esc(state.artist.name)}</em> Archive.`
      : `${esc(tabLabel(tab))}`;
    const lede = tab === "songs"
      ? `<p class="port-note">A port of <a href="https://uziarchive.top" target="_blank" rel="noopener">The Ultimate Uzi Archive</a> by @flexbymistake. Their site, their idea and layout, remade for ${esc(state.artist.name)} using the ${esc(state.artist.trackerName)}. <a href="${L("/credits")}" data-link>Credits</a></p>`
      : `<p class="lede">${items.length.toLocaleString()} entries from the tracker's ${esc(tabLabel(tab))} tab.</p>`;

    view.innerHTML = `
      <section class="hero">
        <h1>${heading}</h1>
        ${lede}
        <div id="search-area">${searchBlock(tab, items)}</div>
      </section>
      <div id="results"></div>`;

    document.title = tab === "songs" ? `${state.artist.name} - archivedownloader` : `${tabLabel(tab)} - ${state.artist.name} - archivedownloader`;
    bindSearch(tab, items);
    renderResults(tab, items);
  }

  function renderResults(tab, items) {
    const box = $("#results");
    if (!box) return;

    if (tab === "songs" && !filtersActive(tab)) {
      const total = state.meta.tabs[0].count;
      box.innerHTML = `
        <section class="panel center">
          <div class="panel-head"><h2>Browse by era</h2></div>
          <div class="era-grid">${state.eraList.map(eraCard).join("")}</div>
        </section>
        <p class="result-count">${total.toLocaleString()} songs across ${state.eraList.length} eras</p>`;
      return;
    }

    const list = applyFilters(items, tab);
    const slice = list.slice(0, state.shown);

    if (!list.length) {
      box.innerHTML = '<p class="empty">Nothing matches that. Try fewer words, or turn on "Also search notes".</p>';
      return;
    }

    // other tabs with no search: keep the tracker's era grouping
    const grouped = tab !== "songs" && !state.filters.q.trim() && state.filters.sort === "era";
    box.innerHTML = `
      <p class="result-count">${list.length.toLocaleString()} ${list.length === 1 ? "result" : "results"}</p>
      <div class="panel" style="margin-top:8px">
        <div class="panel-head">
          <h2>${tab === "songs" ? "Results" : esc(tabLabel(tab))}</h2>
          ${list.some(item => item.audio) ? '<button class="btn small" type="button" data-play-results>▶ Play these</button>' : ""}
        </div>
        ${grouped ? groupedRows(slice, item => item.eraObj ? item.eraObj.name : (item.eraName || "Other"), true) : `<div class="songs">${slice.map(item => songRow(item, { showEra: true })).join("")}</div>`}
        ${list.length > slice.length ? `<button class="btn more" type="button" data-more>Show more (${(list.length - slice.length).toLocaleString()} left)</button>` : ""}
      </div>`;

    box.querySelector("[data-more]")?.addEventListener("click", () => {
      state.shown += PAGE * 2;
      renderResults(tab, items);
    });
    box.querySelector("[data-play-results]")?.addEventListener("click", () => player.playList(list.filter(item => item.audio), 0));
    bindRows(box, list);
  }

  function groupedRows(items, keyOf, showGroup) {
    let html = "";
    let last = null;
    let open = false;
    items.forEach(item => {
      const key = keyOf(item) || "";
      const sub = showGroup && item.group ? ` <span class="n">· ${esc(item.group)}</span>` : "";
      const full = key + "|" + (showGroup ? item.group : "");
      if (full !== last) {
        if (open) html += "</div>";
        html += key ? `<h3 class="session-head">${esc(key)}${sub}</h3><div class="songs">` : '<div class="songs">';
        open = true;
        last = full;
      }
      html += songRow(item, { showEra: false });
    });
    if (open) html += "</div>";
    return html;
  }

  function bindSearch(tab, items) {
    const area = $("#search-area");
    const input = $("#q", area);
    let timer;

    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.filters.q = input.value;
        state.shown = PAGE;
        renderResults(tab, items);
        const clear = area.querySelector("[data-clear]");
        if (input.value && !clear) input.insertAdjacentHTML("afterend", '<button class="clear" type="button" data-clear>Clear</button>');
        if (!input.value && clear) clear.remove();
      }, 120);
    });

    area.addEventListener("click", event => {
      const status = event.target.closest("[data-status]");
      if (status) {
        state.filters.status = status.dataset.status;
        area.querySelectorAll("[data-status]").forEach(btn => btn.setAttribute("aria-pressed", btn === status));
        state.shown = PAGE;
        renderResults(tab, items);
      }
      if (event.target.closest("[data-clear]")) {
        state.filters.q = "";
        input.value = "";
        event.target.closest("[data-clear]").remove();
        input.focus();
        renderResults(tab, items);
      }
      if (event.target.closest("[data-adv]")) {
        const panel = $(".advanced", area);
        panel.hidden = !panel.hidden;
        sessionStorageSet("adv", panel.hidden ? "0" : "1");
        event.target.closest("[data-adv]").innerHTML = `Advanced search ${panel.hidden ? "▾" : "▴"}`;
      }
      if (event.target.closest("[data-reset]")) {
        state.filters = defaultFilters();
        state.shown = PAGE;
        area.innerHTML = searchBlock(tab, items);
        $(".advanced", area).hidden = false;
        bindSearch(tab, items);
        renderResults(tab, items);
      }
    });

    area.addEventListener("change", event => {
      const field = event.target.dataset.f;
      if (!field) return;
      state.filters[field] = event.target.type === "checkbox" ? event.target.checked : event.target.value;
      state.shown = PAGE;
      renderResults(tab, items);
    });

    area.querySelector('[data-f="producer"]')?.addEventListener("input", event => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.filters.producer = event.target.value;
        renderResults(tab, items);
      }, 200);
    });
  }

  function eraCard(era) {
    const h = hue(era.name);
    return `
      <a class="era-card" href="${L(`/era/${encodeURIComponent(era.key)}`)}" data-link style="--c:hsl(${h} 70% 40%)">
        ${coverHTML(era)}
        <strong>${esc(era.name)}</strong>
        <span class="era-meta">${era.year ? `<span>${era.year}</span>` : ""}<span>${era.counts.total} songs</span></span>
      </a>`;
  }

  /* ---------- song rows ---------- */

  function byline(item) {
    const parts = [];
    if (item.features.length) parts.push(item.features.join(", "));
    if (item.producers.length) parts.push("prod. " + item.producers.join(", "));
    if (!parts.length && item.aliases.length) parts.push(item.aliases.join(", "));
    if (!parts.length && item.fields) {
      const note = item.fields.find(field => field.label === "Notes");
      if (note) parts.push(note.value.split("\n")[0]);
    }
    return parts.join(" · ");
  }

  function statusTag(item) {
    if (!item.status) return "";
    const label = { unreleased: "Unreleased", released: "Released", unsurfaced: "Unsurfaced" }[item.status];
    return `<span class="tag status-${item.status}">${label}</span>`;
  }

  function songRow(item, { showEra = false } = {}) {
    const era = item.eraObj;
    const playing = player.current && player.current.id === item.id;
    const smallTag = item.available && item.available !== "Full" ? `<span class="tag">${esc(item.available)}</span>` : "";
    const eraTag = showEra && era ? `<a class="tag era-tag" style="--h:${hue(era.name)}" href="${L(`/era/${encodeURIComponent(era.key)}`)}" data-link>${esc(era.name)}</a>` : "";
    return `
      <article class="song ${playing ? "playing" : ""}" data-id="${item.id}">
        <div class="song-row" data-toggle>
          <button class="song-play" type="button" data-play aria-label="${item.audio ? "Play" : "No file to play"}" ${item.audio ? "" : "disabled"}>
            <svg viewBox="0 0 24 24"><path d="m7 4 13 8-13 8z"/></svg>
          </button>
          ${coverHTML(era, item.eraName)}
          <div class="song-main">
            <div class="song-title"><h3 title="${esc(item.title)}">${esc(item.title)}</h3></div>
            <p class="song-by">${esc(byline(item)) || "&nbsp;"}</p>
          </div>
          <div class="song-side">
            <div class="tags">${eraTag}${statusTag(item)}${smallTag}</div>
            <span class="len">${esc(item.length || lengthField(item) || "")}</span>
          </div>
        </div>
      </article>`;
  }

  function lengthField(item) {
    const field = (item.fields || []).find(f => /length/i.test(f.label) && /^\d+:\d{2}/.test(f.value));
    return field ? field.value : "";
  }

  function meta(label, value, filter) {
    if (!value || value === "N/A") return "";
    const body = filter
      ? value.split(/,\s*|\s+&\s+/).map(part => `<span class="linkish" data-filter="${filter}" data-value="${esc(part)}">${esc(part)}</span>`).join(", ")
      : esc(value);
    return `<div class="meta"><span>${esc(label)}</span><div>${body}</div></div>`;
  }

  function detailHTML(item) {
    const blocks = [];
    if (item.section === "released") {
      blocks.push(meta("Released on", item.release), meta("Release date", item.releaseDate), meta("Type", item.type), meta("On streaming", item.streaming));
    } else if (item.section === "unreleased") {
      blocks.push(meta("Type", item.type), meta("Available", item.available), meta("Quality", item.quality),
        meta("File date", item.fileDate), meta("First preview", item.previewDate), meta("Leak date", item.leakDate), meta("OG file leaked", item.ogLeakDate), meta("Session", item.session));
    }
    blocks.push(
      meta("Producer", item.producers.join(", "), "producer"),
      meta("Features", item.features.join(", ")),
      meta("Alt names", item.aliases.join(", ")),
      meta("Length", item.length));
    (item.fields || []).filter(field => field.label !== "Notes").forEach(field => blocks.push(meta(field.label, field.value)));
    if (item.eraObj) blocks.push(`<div class="meta"><span>Era</span><div><a class="linkish" href="${linkFor(item.artist, `/era/${encodeURIComponent(item.eraObj.key)}`)}" data-link>${esc(item.eraObj.name)}</a></div></div>`);

    const notes = item.notes || ((item.fields || []).find(field => field.label === "Notes") || {}).value || "";
    const external = item.links.filter(link => !item.audio || !link.includes("pillows.su"));

    return `
      <div class="song-detail">
        <div class="meta-grid">${blocks.join("")}</div>
        ${notes ? `<div class="notes">${esc(notes)}</div>` : ""}
        ${external.length ? `<div class="link-list">${external.map(link => `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(link.replace(/^https?:\/\/(www\.)?/, ""))}</a>`).join("")}</div>` : ""}
        ${!item.links.length && item.linkNote ? `<div class="notes">Link: ${esc(item.linkNote)}</div>` : ""}
        <div class="detail-actions">
          ${item.audio ? `<button class="btn small" type="button" data-play>▶ Play</button>
            <button class="btn small" type="button" data-queue>Add to queue</button>
            <a class="btn small" href="/download/${encodeURIComponent(item.artist)}/${item.id}" download data-dl>Download</a>` : ""}
          <button class="btn small" type="button" data-share>Share</button>
          <a class="btn small" href="${esc(item.sheet)}" target="_blank" rel="noopener">Open sheet row</a>
        </div>
      </div>`;
  }

  function toggleRow(article, force) {
    const item = state.byId.get(article.dataset.id);
    const open = force ?? !article.classList.contains("open");
    article.classList.toggle("open", open);
    const existing = article.querySelector(".song-detail");
    if (open && !existing) article.insertAdjacentHTML("beforeend", detailHTML(item));
    if (!open && existing) existing.remove();
  }

  function bindRows(root, list) {
    root.addEventListener("click", event => {
      const article = event.target.closest(".song");
      if (!article || !root.contains(article)) return;
      const item = state.byId.get(article.dataset.id);

      if (event.target.closest("[data-dl]")) return toast("Downloading with tags...");
      if (event.target.closest("a")) return; // era tags, links

      if (event.target.closest("[data-play]")) {
        event.stopPropagation();
        if (player.current && player.current.id === item.id) return player.toggle();
        const playable = list.filter(entry => entry.audio);
        player.playList(playable, Math.max(0, playable.indexOf(item)));
        return;
      }
      if (event.target.closest("[data-queue]")) {
        player.enqueue(item);
        return toast("Added to queue");
      }
      if (event.target.closest("[data-share]")) return copy(`${location.origin}${linkFor(item.artist, `/song/${item.id}`)}`);

      const filter = event.target.closest("[data-filter]");
      if (filter) {
        state.filters = { ...defaultFilters(), [filter.dataset.filter]: filter.dataset.value };
        sessionStorageSet("adv", "1");
        return go(L("/"));
      }

      if (event.target.closest("[data-toggle]")) toggleRow(article);
    });
  }

  /* ---------- era page ---------- */

  function setEraColor(era) {
    document.documentElement.style.setProperty("--era", era ? `hsl(${hue(era.name)} 75% 62%)` : "");
  }

  async function renderEra(key, openId) {
    const era = state.eras.get(key);
    if (!era) return renderNotFound();
    renderTabs("songs");
    setEraColor(era);
    document.title = `${era.name} - ${state.artist.name} - archivedownloader`;

    const songs = (await loadTab("songs")).filter(song => song.era === key);
    // unreleased first in tracker order, released after, like the tracker itself
    const unreleased = songs.filter(song => song.section === "unreleased");
    const released = songs.filter(song => song.section === "released");
    const playable = [...unreleased, ...released].filter(song => song.audio);

    const description = era.description ? era.description.split(/\n+/).map(p => `<p>${esc(p)}</p>`).join("") : "";
    const timeline = era.timeline.length ? `<details><summary>Timeline</summary><ul>${era.timeline.map(t => `<li>${esc(t.replace(/^\(|\)$/g, "").replace(/\) \(/g, " · "))}</li>`).join("")}</ul></details>` : "";

    view.innerHTML = `
      <a class="back" href="${L("/")}" data-link>← All eras</a>
      <section class="era-hero">
        ${coverHTML(era)}
        <div>
          <div class="kicker">${[era.year, era.label].filter(Boolean).map(esc).join(" · ") || "Era"}</div>
          <h1>${esc(era.name)}</h1>
          ${era.aliases.length ? `<p class="aka">Also known as ${esc(era.aliases.join(", "))}</p>` : ""}
          <div class="stat-row">
            <span class="stat"><b>${era.counts.total}</b> songs</span>
            ${era.counts.unreleased ? `<span class="stat" style="color:var(--unreleased)"><b>${era.counts.unreleased}</b> unreleased</span>` : ""}
            ${era.counts.released ? `<span class="stat" style="color:var(--released)"><b>${era.counts.released}</b> released</span>` : ""}
            ${era.counts.unsurfaced ? `<span class="stat" style="color:var(--unsurfaced)"><b>${era.counts.unsurfaced}</b> unsurfaced</span>` : ""}
          </div>
          <div class="era-actions">
            ${playable.length ? `<button class="btn primary" type="button" data-era-play><svg viewBox="0 0 24 24"><path d="m7 4 13 8-13 8z"/></svg>Play era</button>
              <button class="btn" type="button" data-era-shuffle>Shuffle</button>` : ""}
            <button class="btn" type="button" data-era-share>Share</button>
            ${playable.length ? `<button class="btn" type="button" data-zip-toggle aria-expanded="false">
              <svg viewBox="0 0 24 24"><path d="M11 3h2v10.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4 3.6 3.6zM4 19h16v2H4z"/></svg>Download era ZIP</button>` : ""}
          </div>
          ${playable.length ? `<div class="zip-panel" hidden>
            <div class="zip-options">
              <label>Songs<select data-zip="which">
                <option value="all">Everything with a file</option>
                <option value="unreleased">Unreleased only</option>
                <option value="released">Released only</option>
              </select></label>
              <label class="check"><input type="checkbox" data-zip="full"> Skip snippets and partials</label>
            </div>
            <div class="zip-foot">
              <span class="zip-count" data-zip-count></span>
              <a class="btn primary small" data-zip-go href="#" download>Download</a>
            </div>
            <p class="zip-note">Every file is the original upload at its original quality, never converted or re-encoded, with tags added (title, ${esc(state.artist.name)}, era as album, year, track number, producer, cover). The ZIP builds as it downloads, so the browser won't show a total size, and big eras can take a few minutes.</p>
          </div>` : ""}
        </div>
      </section>
      ${description || timeline ? `<div class="about">${description}${timeline}</div>` : ""}
      <div id="era-songs">
        ${unreleased.length ? groupedRows(unreleased, song => song.session || "Unreleased") : ""}
        ${released.length ? `<h3 class="session-head">Released <span class="n">${released.length}</span></h3><div class="songs">${released.map(song => songRow(song)).join("")}</div>` : ""}
      </div>`;

    const list = [...unreleased, ...released];
    bindRows($("#era-songs"), list);
    $("[data-era-play]")?.addEventListener("click", () => player.playList(playable, 0));
    $("[data-era-shuffle]")?.addEventListener("click", () => player.playList(playable, 0, { shuffle: true }));
    $("[data-era-share]").addEventListener("click", () => copy(`${location.origin}${L(`/era/${encodeURIComponent(era.key)}`)}`));
    bindZipPanel(era, playable);

    if (openId) {
      const article = view.querySelector(`.song[data-id="${CSS.escape(openId)}"]`);
      if (article) {
        toggleRow(article, true);
        requestAnimationFrame(() => article.scrollIntoView({ block: "center" }));
      }
    } else {
      window.scrollTo(0, 0);
    }
  }

  function bindZipPanel(era, playable) {
    const toggle = $("[data-zip-toggle]");
    const panel = $(".zip-panel");
    if (!toggle || !panel) return;
    const which = $('[data-zip="which"]', panel);
    const full = $('[data-zip="full"]', panel);
    const go = $("[data-zip-go]", panel);
    const count = $("[data-zip-count]", panel);
    const snippetish = /^(snippet|partial|tagged|beat only)$/i;

    const update = () => {
      const seen = new Set();
      const picked = playable.filter(song =>
        (which.value === "all" || song.status === which.value) &&
        (!full.checked || !snippetish.test(song.available || "")) &&
        !seen.has(song.audio.src) && seen.add(song.audio.src));
      count.textContent = `${picked.length} ${picked.length === 1 ? "file" : "files"} + cover + tracklist`;
      go.href = `/zip/${encodeURIComponent(state.artistKey)}/${encodeURIComponent(era.key)}?which=${which.value}${full.checked ? "&full=1" : ""}`;
      go.classList.toggle("disabled", !picked.length);
    };

    toggle.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", !panel.hidden);
    });
    which.addEventListener("change", update);
    full.addEventListener("change", update);
    go.addEventListener("click", event => {
      if (go.classList.contains("disabled")) return event.preventDefault();
      toast("Download starting...");
    });
    update();
  }

  async function renderSong(id) {
    // a song can live in any tab; songs is by far the likeliest
    let item = state.byId.get(id);
    if (!item) {
      await loadTab("songs");
      item = state.byId.get(id);
    }
    if (!item) {
      for (const tab of state.meta.tabs) {
        await loadTab(tab.key);
        item = state.byId.get(id);
        if (item) break;
      }
    }
    if (!item) return renderNotFound("That song isn't on the tracker any more.");

    if (songTab(item) === "songs" && item.era) {
      history.replaceState({}, "", L(`/era/${encodeURIComponent(item.era)}?song=${item.id}`));
      return renderEra(item.era, item.id);
    }

    renderTabs(item.section);
    view.innerHTML = `<a class="back" href="${L(`/tab/${item.section}`)}" data-link>← ${esc(tabLabel(item.section))}</a><div class="songs" id="single" style="margin-top:18px">${songRow(item, { showEra: true })}</div>`;
    bindRows($("#single"), [item]);
    toggleRow($("#single .song"), true);
  }

  /* ---------- credits (same idea as uziarchive.top/credits) ---------- */

  // the people behind the original site, with the roles their credits page gives them
  const ORIGINAL_CREDITS = [
    { name: "zdb", handle: "@zdb_", roles: ["Song & Snippet Tracker"] },
    { name: "Bully", handle: "@localbully88", roles: ["Studio Session Archive", "Lives Archive", "Snippets Archive"] },
    { name: "Flex By Mistake", handle: "@flexbymistake", roles: ["Site Creator", "Performances Archive", "Snippets Archive", "Lives Archive"], lead: true },
    { name: "Overlord", handle: "@wrldoverlord", roles: ["Song & Snippet Tracker", "File Archive"] }
  ];

  function creditCard(person, index) {
    const link = person.url ? `<a class="credit-link" href="${esc(person.url)}" target="_blank" rel="noopener">${esc(person.linkText || person.url.replace(/^https?:\/\//, ""))}</a>` : "";
    return `
      <article class="credit-card ${person.lead ? "lead" : ""}">
        <span class="credit-num">${String(index + 1).padStart(2, "0")}</span>
        <div class="credit-body">
          <h3 class="${person.name.length > 13 ? "longer" : person.name.length > 9 ? "long" : ""}">${esc(person.name)}</h3>
          ${person.handle ? `<p class="credit-handle">${esc(person.handle)}</p>` : ""}
          <ul>${person.roles.map(role => `<li>${esc(role)}</li>`).join("")}</ul>
          ${link}
        </div>
      </article>`;
  }

  function renderCredits() {
    renderTabs("credits");
    setEraColor(null);
    const a = state.artist;
    document.title = `Credits - ${a.name} - archivedownloader`;

    const trackerCredits = [
      { name: a.trackerName, roles: ["Every song, era, date and note on this site", "Era covers"], url: a.sheetUrl, linkText: "Open the tracker", lead: true },
      ...a.credits.map(name => ({ name, roles: [`${a.trackerName} editor`] }))
    ];
    const fileCredits = [
      { name: "pillows.su", roles: ["Hosts most of the song files"], url: "https://pillows.su", linkText: "pillows.su" },
      { name: "imgur.gg", roles: ["Hosts lives and many snippets"], url: "https://imgur.gg", linkText: "imgur.gg" },
      { name: "pixeldrain", roles: ["Hosts files for some trackers"], url: "https://pixeldrain.com", linkText: "pixeldrain.com" }
    ];

    view.innerHTML = `
      <section class="credits-page">
        <h1 class="credits-title">Credits.</h1>
        <p class="credits-lead">archivedownloader is a port of <a href="https://uziarchive.top" target="_blank" rel="noopener">The Ultimate Uzi Archive</a>, remade to work with other artists' trackers. The site, the idea, the layout and the features are theirs. These are the people who made it, and the people who keep the ${esc(a.name)} tracker going.</p>

        <div class="panel credits-panel">
          <div class="panel-head">
            <h2>The original: The Ultimate Uzi Archive</h2>
            <a class="btn small" href="https://uziarchive.top" target="_blank" rel="noopener">Visit uziarchive.top</a>
          </div>
          <div class="credit-grid">${ORIGINAL_CREDITS.map(creditCard).join("")}</div>
          <p class="credits-small">Names, handles and roles as listed on uziarchive.top/credits. None of them make or run this port, so please don't send them problems with it.</p>
        </div>

        <div class="panel credits-panel">
          <div class="panel-head">
            <h2>The ${esc(a.trackerName)}</h2>
            <a class="btn small" href="${esc(a.sheetUrl)}" target="_blank" rel="noopener">Open the tracker</a>
          </div>
          <p class="credits-small" style="margin:0 0 16px">Every ${esc(a.name)} song, era, date, note and cover on this page comes from the ${esc(a.trackerName)} and the people who edit it.${a.builtIn && a.key !== state.defaultArtist || !a.builtIn ? " Editors are as listed for this tracker on TrackerHub." : ""}</p>
          <div class="credit-grid">${trackerCredits.map(creditCard).join("")}</div>
          ${a.credits.length ? "" : `<p class="credits-small">This tracker's editors aren't listed on TrackerHub. Open the tracker to see who keeps it.</p>`}
        </div>

        <div class="panel credits-panel">
          <div class="panel-head"><h2>Files</h2></div>
          <div class="credit-grid">${fileCredits.map(creditCard).join("")}</div>
          <p class="credits-small">This site doesn't host or store any music. It lists what each tracker lists and links to where the files already are.</p>
        </div>
      </section>`;
    window.scrollTo(0, 0);
  }

  function renderNotFound(message = "That page doesn't exist.") {
    renderTabs("");
    view.innerHTML = `<p class="empty">${esc(message)} <a href="${L("/")}" data-link>Back to the archive</a></p>`;
  }

  async function render() {
    state.route = parseRoute();
    const route = state.route;
    try {
      await useArtist(route.artist);
      if (state.route !== route) return;
      if (route.name === "missing") renderNotFound();
      else if (route.name === "era") await renderEra(route.era, route.open);
      else if (route.name === "song") await renderSong(route.id);
      else if (route.name === "credits") renderCredits();
      else {
        state.shown = PAGE;
        await renderTab(route.tab);
      }
    } catch (err) {
      if (err.message === "switched artist" || state.route !== route) return;
      console.error(err);
      view.innerHTML = `<div class="empty"><p>Couldn't load this tracker: ${esc(err.message)}</p><p><a href="/" data-link>Back to the main archive</a></p></div>`;
    }
    markPlaying();
  }

  /* ---------- player ---------- */

  const audio = $("#audio");
  const ui = {
    bar: $("#player"),
    title: $("#now-title"),
    sub: $("#now-sub"),
    art: $("#now-art"),
    fill: $("#fill"),
    buffer: $("#buffer"),
    progress: $("#progress"),
    time: $("#time"),
    shuffle: $("#shuffle"),
    repeat: $("#repeat"),
    volume: $("#volume"),
    queue: $("#queue"),
    queueList: $("#queue-list")
  };

  const fmt = seconds => {
    if (!isFinite(seconds)) return "0:00";
    const s = Math.floor(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  const player = {
    queue: [],
    index: -1,
    current: null,
    shuffle: false,
    repeat: false,

    playList(list, start = 0, { shuffle = false } = {}) {
      if (!list.length) return;
      this.queue = list.slice();
      if (shuffle) {
        for (let i = this.queue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
        }
        start = 0;
      }
      this.load(start);
    },

    enqueue(item) {
      if (!item.audio) return;
      if (!this.current) return this.playList([item], 0);
      this.queue.splice(this.index + 1 + this.queue.slice(this.index + 1).filter(q => q.queued).length, 0, Object.assign(item, { queued: true }));
      renderQueue();
    },

    load(index) {
      const item = this.queue[index];
      if (!item) return;
      this.index = index;
      this.current = item;
      audio.src = item.audio.src;
      audio.play().catch(() => {});
      ui.bar.hidden = false;
      document.body.classList.add("has-player");
      ui.bar.classList.add("is-loading");
      ui.title.textContent = item.title;
      ui.sub.textContent = [item.eraObj ? item.eraObj.name : item.eraName, byline(item)].filter(Boolean).join(" · ");
      ui.art.innerHTML = coverHTML(item.eraObj, item.eraName);
      document.title = `${item.title} - archivedownloader`;
      setMediaSession(item);
      markPlaying();
      renderQueue();
    },

    toggle() {
      if (!this.current) return;
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    },

    next(auto = false) {
      if (!this.queue.length) return;
      if (auto && this.repeat) {
        audio.currentTime = 0;
        return audio.play();
      }
      let nextIndex = this.index + 1;
      if (this.shuffle && this.queue.length > 1) {
        do nextIndex = Math.floor(Math.random() * this.queue.length); while (nextIndex === this.index);
      }
      if (nextIndex >= this.queue.length) {
        if (auto) return;
        nextIndex = 0;
      }
      this.load(nextIndex);
    },

    prev() {
      if (audio.currentTime > 4) {
        audio.currentTime = 0;
        return;
      }
      this.load(Math.max(0, this.index - 1));
    }
  };

  function markPlaying() {
    document.querySelectorAll(".song.playing").forEach(el => el.classList.remove("playing"));
    if (player.current) {
      document.querySelectorAll(`.song[data-id="${CSS.escape(player.current.id)}"]`).forEach(el => el.classList.add("playing"));
    }
  }

  function renderQueue() {
    if (ui.queue.hidden) return;
    const items = player.queue;
    ui.queueList.innerHTML = items.length ? items.map((item, i) => `
      <li data-i="${i}" class="${i === player.index ? "current" : ""}">
        ${coverHTML(item.eraObj, item.eraName)}
        <div><strong>${esc(item.title)}</strong><small>${esc(item.eraObj ? item.eraObj.name : item.eraName || "")}</small></div>
        <button type="button" data-remove="${i}" aria-label="Remove">×</button>
      </li>`).join("") : '<li style="cursor:default;color:var(--muted)">Nothing queued.</li>';
    const current = ui.queueList.querySelector(".current");
    if (current) current.scrollIntoView({ block: "nearest" });
  }

  ui.queueList.addEventListener("click", event => {
    const remove = event.target.closest("[data-remove]");
    if (remove) {
      const i = Number(remove.dataset.remove);
      player.queue.splice(i, 1);
      if (i < player.index) player.index--;
      else if (i === player.index) {
        if (player.queue.length) player.load(Math.min(i, player.queue.length - 1));
        else audio.pause();
      }
      return renderQueue();
    }
    const row = event.target.closest("[data-i]");
    if (row) player.load(Number(row.dataset.i));
  });

  $("#queue-btn").addEventListener("click", () => {
    ui.queue.hidden = !ui.queue.hidden;
    renderQueue();
  });
  $("#queue-close").addEventListener("click", () => { ui.queue.hidden = true; });
  $("#queue-clear").addEventListener("click", () => {
    player.queue = player.current ? [player.current] : [];
    player.index = player.current ? 0 : -1;
    renderQueue();
  });

  $("#toggle").addEventListener("click", () => player.toggle());
  $("#next").addEventListener("click", () => player.next());
  $("#prev").addEventListener("click", () => player.prev());
  ui.shuffle.addEventListener("click", () => {
    player.shuffle = !player.shuffle;
    ui.shuffle.setAttribute("aria-pressed", player.shuffle);
  });
  ui.repeat.addEventListener("click", () => {
    player.repeat = !player.repeat;
    ui.repeat.setAttribute("aria-pressed", player.repeat);
  });
  $("#now").addEventListener("click", () => {
    if (player.current) go(linkFor(player.current.artist, `/song/${player.current.id}`));
  });

  try {
    const saved = localStorage.getItem("volume");
    if (saved !== null) audio.volume = ui.volume.value = Number(saved);
  } catch { /* storage blocked */ }
  ui.volume.addEventListener("input", () => {
    audio.volume = Number(ui.volume.value);
    try { localStorage.setItem("volume", ui.volume.value); } catch { /* storage blocked */ }
  });

  audio.addEventListener("play", () => ui.bar.classList.add("is-playing"));
  audio.addEventListener("pause", () => ui.bar.classList.remove("is-playing"));
  audio.addEventListener("playing", () => ui.bar.classList.remove("is-loading"));
  audio.addEventListener("waiting", () => ui.bar.classList.add("is-loading"));
  audio.addEventListener("ended", () => player.next(true));
  audio.addEventListener("error", () => {
    if (!player.current) return;
    ui.bar.classList.remove("is-loading");
    toast("That file couldn't be played, skipping");
    setTimeout(() => player.next(true), 900);
  });
  audio.addEventListener("timeupdate", () => {
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    ui.fill.style.width = pct + "%";
    ui.progress.setAttribute("aria-valuenow", Math.round(pct));
    ui.time.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
    if ("mediaSession" in navigator && audio.duration && navigator.mediaSession.setPositionState) {
      try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: audio.currentTime, playbackRate: 1 }); } catch { /* ignore */ }
    }
  });
  audio.addEventListener("progress", () => {
    if (audio.buffered.length && audio.duration) {
      ui.buffer.style.width = (audio.buffered.end(audio.buffered.length - 1) / audio.duration) * 100 + "%";
    }
  });

  // drag / tap to seek
  function seekFrom(event) {
    const rect = ui.progress.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    if (audio.duration) audio.currentTime = pct * audio.duration;
  }
  ui.progress.addEventListener("pointerdown", event => {
    ui.progress.setPointerCapture(event.pointerId);
    seekFrom(event);
    const move = e => seekFrom(e);
    ui.progress.addEventListener("pointermove", move);
    ui.progress.addEventListener("pointerup", () => ui.progress.removeEventListener("pointermove", move), { once: true });
  });
  ui.progress.addEventListener("keydown", event => {
    if (event.key === "ArrowRight") audio.currentTime += 5;
    if (event.key === "ArrowLeft") audio.currentTime -= 5;
  });

  document.addEventListener("keydown", event => {
    if (event.target.closest("input, textarea, select, [contenteditable]")) return;
    if (event.code === "Space" && player.current) {
      event.preventDefault();
      player.toggle();
    }
  });

  function setMediaSession(item) {
    if (!("mediaSession" in navigator)) return;
    const era = item.eraObj;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.title,
      artist: [item.artistName || "", ...item.features.map(f => f.replace(/^(feat\.?|with|ft\.?)\s*/i, ""))].join(", "),
      album: era ? era.name : (item.eraName || ""),
      artwork: era && era.cover ? [{ src: era.cover, sizes: "512x512" }] : []
    });
    navigator.mediaSession.setActionHandler("play", () => audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => player.next());
    navigator.mediaSession.setActionHandler("previoustrack", () => player.prev());
    try {
      navigator.mediaSession.setActionHandler("seekto", details => { audio.currentTime = details.seekTime; });
    } catch { /* not supported */ }
  }

  /* ---------- start ---------- */

  async function start() {
    view.innerHTML = '<div class="loading">Loading...</div>';
    try {
      const list = await getJSON("/api/artists");
      state.artists = list.artists;
      state.defaultArtist = list.defaultArtist;
      state.allowCustom = list.allowCustom;
    } catch (err) {
      view.innerHTML = `<p class="empty">Couldn't reach the site: ${esc(err.message)}. Refresh in a minute.</p>`;
      return;
    }
    render();
  }

  start();
})();
