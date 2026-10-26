/* Flashcards — decks + SM-2 spaced repetition, all saved in localStorage. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;
  var DAY = 864e5, MAX_CARDS = 20000;

  // ---------- SM-2 ----------
  // q: 1 = Again, 3 = Hard, 4 = Good, 5 = Easy (SM-2 quality scale 0-5).
  function startOfDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function addDays(ms, n) { var d = new Date(startOfDay(ms)); d.setDate(d.getDate() + n); return d.getTime(); }
  function sm2(c, q, now) {
    var r = { ef: c.ef, reps: c.reps, ivl: c.ivl, lapses: c.lapses || 0 };
    if (q < 3) { r.reps = 0; r.ivl = 1; r.lapses++; }
    else { r.ivl = c.reps === 0 ? 1 : c.reps === 1 ? 6 : Math.round(c.ivl * c.ef); r.reps = c.reps + 1; }
    r.ef = Math.max(1.3, +(c.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))).toFixed(4));
    // A failed card comes back in this session, then tomorrow; a passed card at local midnight N days from now.
    r.due = q < 3 ? now : addDays(now, r.ivl);
    return r;
  }
  function newCard(f, b) { return { id: uid(), f: f, b: b, ef: 2.5, reps: 0, ivl: 0, due: 0, lapses: 0, seen: false }; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function ivlLabel(q, c) { if (q < 3) return "again now"; var n = sm2(c, q, Date.now()).ivl; return n === 1 ? "1 day" : n < 31 ? n + " days" : n < 365 ? Math.round(n / 30) + " mo" : (n / 365).toFixed(1) + " yr"; }

  // ---------- CSV ----------
  function detectDelim(text) {
    var first = text.split(/\r?\n/).filter(function (l) { return l.trim(); })[0] || "";
    if (first.indexOf("\t") >= 0) return "\t";
    return (first.split(";").length > first.split(",").length) ? ";" : ",";
  }
  function parseCSV(text, delim) {
    var rows = [], row = [], f = "", i = 0, q = false, c;
    while (i < text.length) {
      c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"' && f === "") q = true;
      else if (c === delim) { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
      else f += c;
      i++;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  function csvCell(s) { return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function toCSV(cards) { return cards.map(function (c) { return csvCell(c.f) + "," + csvCell(c.b); }).join("\n") + "\n"; }
  function rowsToCards(rows, header, swap) {
    return rows.slice(header ? 1 : 0).map(function (r) { return r.map(function (x) { return x.trim(); }); })
      .filter(function (r) { return r.length >= 2 && (r[0] || r[1]); })
      .map(function (r) { return swap ? [r[1], r[0]] : [r[0], r[1]]; });
  }

  // ---------- state ----------
  var data = S3.store("fc.data");
  if (!data || !Array.isArray(data.decks) || !data.decks.length) data = { decks: [{ id: uid(), name: "My first deck", cards: [] }], cur: null };
  if (!deckById(data.cur)) data.cur = data.decks[0].id;
  var tab = "study", queue = [], current = null, flipped = false, editing = null;
  function deckById(id) { return data.decks.filter(function (d) { return d.id === id; })[0]; }
  function deck() { return deckById(data.cur); }
  function save() { S3.store("fc.data", data); }
  function newLimit() { return Math.max(0, parseInt($("#newLimit").value, 10) || 0); }

  function counts(d, now) {
    var c = { total: d.cards.length, due: 0, fresh: 0, learned: 0, mature: 0 };
    d.cards.forEach(function (x) {
      if (!x.seen) c.fresh++; else { c.learned++; if (x.due <= now) c.due++; if (x.ivl >= 21) c.mature++; }
    });
    return c;
  }

  // ---------- render ----------
  function renderDecks() {
    var sel = $("#deck"); sel.innerHTML = "";
    data.decks.forEach(function (d) { var o = S3.h("option", { value: d.id, text: d.name + " (" + d.cards.length + ")" }); if (d.id === data.cur) o.selected = true; sel.appendChild(o); });
    $("#delDeck").disabled = data.decks.length < 2;
  }
  function stat(label, v, cls) { return '<div class="stat ' + (cls || "") + '"><b>' + S3.esc(v) + "</b><span>" + S3.esc(label) + "</span></div>"; }
  function renderStats() {
    var c = counts(deck(), Date.now());
    $("#stats").innerHTML = stat("due now", c.due, "due") + stat("new", c.fresh) + stat("cards", c.total) + stat("learning / learned", c.learned) + stat("mature (21d+)", c.mature);
  }
  function buildQueue() {
    var now = Date.now(), d = deck();
    var due = d.cards.filter(function (x) { return x.seen && x.due <= now; }).sort(function (a, b) { return a.due - b.due; });
    var fresh = d.cards.filter(function (x) { return !x.seen; }).slice(0, newLimit());
    queue = due.concat(fresh); current = null; flipped = false;
  }
  function nextCard() { current = queue.shift() || null; flipped = false; renderStudy(); }
  function renderStudy() {
    var empty = !current;
    $("#studyBox").hidden = empty; $("#studyEmpty").hidden = !empty;
    $("#left").textContent = current ? (queue.length + 1) + " left" : "";
    if (empty) {
      var d = deck(), soon = d.cards.filter(function (x) { return x.seen; }).map(function (x) { return x.due; }).sort(function (a, b) { return a - b; })[0];
      var box = $("#studyEmpty"); box.innerHTML = "";
      if (!d.cards.length) box.appendChild(S3.h("div", null, [S3.h("b", { text: "No cards yet" }), "Add some on the Cards tab, or import a CSV."]));
      else {
        box.appendChild(S3.h("div", null, [S3.h("b", { text: "All caught up 🎉" }),
          soon ? "Next review: " + new Date(soon).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) + "." : "No reviews scheduled.",
          counts(d, Date.now()).fresh ? " New cards are waiting. Raise the new-card limit to study more." : ""]));
        var again = S3.h("button", { "class": "btn mt", text: "Study again" });
        again.addEventListener("click", function () { buildQueue(); nextCard(); });
        box.appendChild(S3.h("div", null, [again]));
      }
      return;
    }
    $("#front").textContent = current.f; $("#front2").textContent = current.f; $("#back").textContent = current.b;
    $("#flip").classList.toggle("flipped", flipped);
    $("#grades").hidden = !flipped; $("#showRow").hidden = flipped;
    [1, 3, 4, 5].forEach(function (q) { $("#g" + q).textContent = ivlLabel(q, current); });
  }
  function fmtWhen(c) {
    if (!c.seen) return "new";
    var d = Math.round((startOfDay(c.due) - startOfDay(Date.now())) / DAY);
    return c.due <= Date.now() ? "due now" : d <= 0 ? "later today" : d === 1 ? "tomorrow" : "in " + d + " days";
  }
  function renderList() {
    var q = $("#q").value.trim().toLowerCase(), tb = $("#list"), cards = deck().cards;
    var shown = cards.filter(function (c) { return !q || (c.f + "\n" + c.b).toLowerCase().indexOf(q) >= 0; });
    tb.innerHTML = "";
    shown.slice(0, 500).forEach(function (c) {
      var ed = S3.h("button", { "class": "btn ghost small", text: "Edit" }), del = S3.h("button", { "class": "btn ghost icon small danger", "aria-label": "Delete card", html: S3.icon("trash") });
      ed.addEventListener("click", function () { editing = c.id; $("#cf").value = c.f; $("#cb").value = c.b; $("#cardSubmit").lastChild.textContent = "Save card"; $("#cardCancel").hidden = false; $("#cf").focus(); });
      del.addEventListener("click", function () { deck().cards = deck().cards.filter(function (x) { return x !== c; }); save(); refresh(); });
      tb.appendChild(S3.h("tr", null, [S3.h("td", { "class": "ct", dir: "auto", text: c.f }), S3.h("td", { "class": "ct", dir: "auto", text: c.b }), S3.h("td", { "class": "when", text: fmtWhen(c) }), S3.h("td", { "class": "acts" }, [ed, del])]));
    });
    $("#listWrap").hidden = !cards.length; $("#listEmpty").hidden = !!cards.length;
  }
  function refresh() { renderDecks(); renderStats(); renderList(); }
  function setTab(v) {
    tab = v;
    $$("#tab button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === v)); });
    ["study", "cards", "io"].forEach(function (k) { $("#p-" + k).hidden = k !== v; });
    if (v === "study") { buildQueue(); nextCard(); }
  }

  // ---------- study actions ----------
  function flip() { if (!current) return; flipped = !flipped; renderStudy(); }
  function grade(q) {
    if (!current || !flipped) return;
    var r = sm2(current, q, Date.now());
    Object.assign(current, r, { seen: true });
    if (q < 3) queue.push(current);
    save(); renderStats(); S3.done();
    nextCard();
  }
  $("#flip").addEventListener("click", flip);
  $("#show").addEventListener("click", flip);
  $$("#grades button").forEach(function (b) { b.addEventListener("click", function () { grade(+b.dataset.q); }); });
  document.addEventListener("keydown", function (e) {
    if (tab !== "study" || e.target.closest("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Space" || e.key === "Enter") { if (e.target.closest("button") && e.key === "Enter") return; e.preventDefault(); flip(); }
    var map = { "1": 1, "2": 3, "3": 4, "4": 5 };
    if (map[e.key] && flipped) grade(map[e.key]);
  });
  $("#newLimit").value = S3.store("fc.newLimit") != null ? S3.store("fc.newLimit") : 20;
  $("#newLimit").addEventListener("change", function () { S3.store("fc.newLimit", newLimit()); buildQueue(); nextCard(); });

  // ---------- decks ----------
  $("#deck").addEventListener("change", function () { data.cur = $("#deck").value; save(); refresh(); setTab(tab); });
  $("#newDeck").addEventListener("click", function () {
    var n = (window.prompt("Name of the new deck:", "") || "").trim().slice(0, 80); if (!n) return;
    var d = { id: uid(), name: n, cards: [] }; data.decks.push(d); data.cur = d.id; save(); refresh(); setTab("cards");
  });
  $("#renameDeck").addEventListener("click", function () {
    var n = (window.prompt("Rename deck:", deck().name) || "").trim().slice(0, 80); if (!n) return;
    deck().name = n; save(); refresh();
  });
  $("#delDeck").addEventListener("click", function () {
    if (data.decks.length < 2 || !window.confirm('Delete the deck "' + deck().name + '" and its ' + deck().cards.length + " cards? Export a backup first if unsure.")) return;
    data.decks = data.decks.filter(function (d) { return d.id !== data.cur; }); data.cur = data.decks[0].id; save(); refresh(); setTab(tab);
  });
  $$("#tab button").forEach(function (b) { b.addEventListener("click", function () { setTab(b.dataset.v); }); });

  // ---------- cards ----------
  function resetForm() { editing = null; $("#cf").value = ""; $("#cb").value = ""; $("#cardSubmit").lastChild.textContent = "Add card"; $("#cardCancel").hidden = true; }
  $("#cardForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = $("#cf").value.trim(), b = $("#cb").value.trim();
    if (!f || !b) { S3.toast("Fill in both sides", "error"); return; }
    if (editing) { var c = deck().cards.filter(function (x) { return x.id === editing; })[0]; if (c) { c.f = f; c.b = b; } S3.toast("Card saved"); }
    else { if (deck().cards.length >= MAX_CARDS) { S3.toast("This deck is full", "error"); return; } deck().cards.push(newCard(f, b)); }
    resetForm(); save(); refresh(); $("#cf").focus();
  });
  $("#cardCancel").addEventListener("click", resetForm);
  ["#cf", "#cb"].forEach(function (id) { $(id).addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("#cardForm").requestSubmit(); } }); });
  $("#q").addEventListener("input", S3.debounce(renderList, 150));

  // ---------- import / export ----------
  function pending() { var t = $("#paste").value; return t.trim() ? rowsToCards(parseCSV(t, detectDelim(t)), $("#header").checked, $("#swap").checked) : []; }
  function updatePreview() { var n = pending().length; $("#preview").textContent = $("#paste").value.trim() ? n + " card" + (n === 1 ? "" : "s") + " found" : ""; }
  ["input", "change"].forEach(function (ev) { $("#paste").addEventListener(ev, S3.debounce(updatePreview, 150)); });
  $("#header").addEventListener("change", updatePreview); $("#swap").addEventListener("change", updatePreview);
  $("#doImport").addEventListener("click", function () {
    var rows = pending();
    if (!rows.length) { S3.toast("No cards found. Use one card per line: front, back", "error"); return; }
    var room = MAX_CARDS - deck().cards.length;
    rows.slice(0, room).forEach(function (r) { deck().cards.push(newCard(r[0].slice(0, 2000), r[1].slice(0, 4000))); });
    S3.toast("Imported " + Math.min(rows.length, room) + " cards"); S3.done();
    $("#paste").value = ""; updatePreview(); save(); refresh();
  });
  function importJSON(text) {
    var j; try { j = JSON.parse(text); } catch (e) { S3.toast("That JSON file couldn't be read", "error"); return; }
    if (!j || !Array.isArray(j.decks)) { S3.toast("Not a Flashcards backup", "error"); return; }
    var str = function (v, n) { return typeof v === "string" ? v.slice(0, n) : ""; }, num = function (v, d) { return typeof v === "number" && isFinite(v) ? v : d; };
    var added = 0;
    j.decks.slice(0, 200).forEach(function (d) {
      if (!d || !Array.isArray(d.cards)) return;
      var nd = { id: uid(), name: str(d.name, 80) || "Imported deck", cards: [] };
      d.cards.slice(0, MAX_CARDS).forEach(function (c) {
        if (!c || !str(c.f, 2000) || !str(c.b, 4000)) return;
        var x = newCard(str(c.f, 2000), str(c.b, 4000));
        x.ef = Math.max(1.3, Math.min(5, num(c.ef, 2.5))); x.reps = Math.max(0, Math.round(num(c.reps, 0))); x.ivl = Math.max(0, Math.round(num(c.ivl, 0)));
        x.due = num(c.due, 0); x.lapses = Math.max(0, Math.round(num(c.lapses, 0))); x.seen = c.seen === true;
        nd.cards.push(x); added++;
      });
      data.decks.push(nd);
    });
    data.cur = data.decks[data.decks.length - 1].id;
    save(); refresh(); setTab("cards"); S3.toast("Restored " + added + " cards"); S3.done();
  }
  $("#openFile input").addEventListener("change", function (e) {
    var f = e.target.files[0]; e.target.value = ""; if (!f) return;
    S3.readFile(f, "text").then(function (t) {
      if (/\.json$/i.test(f.name)) importJSON(t); else { $("#paste").value = t; updatePreview(); }
    });
  });
  $("#expCsv").addEventListener("click", function () {
    if (!deck().cards.length) { S3.toast("This deck has no cards", "error"); return; }
    S3.download(toCSV(deck().cards), (deck().name.replace(/[^\w؀-ۿ -]+/g, "").trim() || "deck") + ".csv", "text/csv"); S3.done();
  });
  $("#expJson").addEventListener("click", function () { S3.download(JSON.stringify({ app: "s3eidat-flashcards", version: 1, decks: data.decks }, null, 1), "flashcards-backup.json", "application/json"); S3.done(); });

  refresh(); setTab("study");

  window.S3_DEMO = function () {
    var d = { id: uid(), name: "Arabic basics", cards: [] };
    [["Hello", "مرحبا"], ["Thank you", "شكرا"], ["Book", "كتاب"], ["Water", "ماء"], ["Good morning", "صباح الخير"], ["Friend", "صديق"], ["House", "بيت"], ["Sun", "شمس"]]
      .forEach(function (p, i) { var c = newCard(p[0], p[1]); if (i > 3) { c.seen = true; c.reps = 2; c.ivl = [3, 8, 15, 30][i - 4]; c.due = addDays(Date.now(), i - 5); } d.cards.push(c); });
    data.decks.push(d); data.cur = d.id; refresh(); setTab("study"); flip();
  };

  window.S3_SELFTEST = function () {
    var now = new Date(2026, 0, 10, 15).getTime(), c = newCard("a", "b");
    var r1 = sm2(c, 4, now), r2 = sm2(r1, 4, now), r3 = sm2(r2, 4, now);
    var a = r1.ivl === 1 && r2.ivl === 6 && r3.ivl === 15 && r3.ef === 2.5 && r1.due === new Date(2026, 0, 11).getTime();
    var e1 = sm2(c, 5, now), e2 = sm2(e1, 5, now), e3 = sm2(e2, 5, now); // EF 2.6 -> 2.7 -> 2.8, interval uses EF before the update
    var b = e1.ef === 2.6 && e2.ivl === 6 && e3.ivl === 16 && Math.abs(e3.ef - 2.8) < 1e-9;
    var h = sm2(c, 3, now), f = sm2(r3, 1, now);
    var d = h.ef === 2.36 && h.ivl === 1 && f.reps === 0 && f.ivl === 1 && f.due === now && f.ef === 1.96 && f.lapses === 1;
    var low = sm2({ ef: 1.4, reps: 3, ivl: 10 }, 1, now).ef === 1.3;
    var rows = parseCSV('front,back\n"Hello, world","say ""hi"""\r\nكتاب,book\n', ",");
    var g = rows.length === 3 && rows[1][0] === "Hello, world" && rows[1][1] === 'say "hi"' && rows[2][0] === "كتاب";
    var cards = rowsToCards(rows, true, false), rt = parseCSV(toCSV(cards.map(function (p) { return { f: p[0], b: p[1] }; })), ",");
    var i = cards.length === 2 && rt[0][1] === 'say "hi"' && detectDelim("a\tb\nc\td") === "\t" && detectDelim("a;b;c") === ";";
    return a && b && d && low && g && i;
  };
})();
