const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtTs(ts) {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString();
  } catch {
    return String(ts);
  }
}

function applyFilters(events) {
  const type = ($("typeFilter")?.value || "").trim();
  const sev = ($("sevFilter")?.value || "").trim();
  const q = ($("q")?.value || "").trim().toLowerCase();

  return (events || []).filter((e) => {
    if (type && e.type !== type) return false;
    if (sev && e.severity !== sev) return false;
    if (q) {
      const hay = `${e.title || ""}\n${e.summary || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function render(events) {
  const el = $("list");
  const list = applyFilters(events);

  if (!list.length) {
    el.innerHTML = `<div class="note">No events match the current filters.</div>`;
    return;
  }

  el.innerHTML = list
    .map((e) => {
      const sev = e.severity || "info";
      return `
        <div class="event" role="article">
          <div class="eventTop">
            <div>
              <div class="eventTitle">${esc(e.title || "(untitled)")}</div>
              <div class="eventMeta mono">${esc(fmtTs(e.ts))}</div>
            </div>
            <div class="badges">
              <span class="badge">${esc(e.type || "event")}</span>
              <span class="badge ${esc(sev)}">${esc(sev)}</span>
            </div>
          </div>
          ${e.summary ? `<div class="eventSummary">${esc(e.summary)}</div>` : ""}
        </div>
      `;
    })
    .join("");
}

async function refresh() {
  const note = $("note");
  note.textContent = "";

  try {
    $("lastUpdated").textContent = "Last updated: fetching…";
    const url = "/activity.json?t=" + Date.now();
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    $("raw").textContent = JSON.stringify(data, null, 2);
    $("lastUpdated").textContent = `Last updated: ${fmtTs(data.updatedAt)}`;

    const events = Array.isArray(data.events) ? data.events : [];
    render(events);
  } catch (err) {
    note.textContent = `Refresh failed: ${String(err)}`;
    $("lastUpdated").textContent = `Last updated: ${new Date().toLocaleString()} (failed)`;
    $("list").innerHTML = "";
    $("raw").textContent = "(empty)";
  }
}

function main() {
  $("refreshBtn").addEventListener("click", refresh);
  ["typeFilter", "sevFilter", "q"].forEach((id) => {
    $(id).addEventListener("input", () => {
      try {
        const data = JSON.parse($("raw").textContent || "{}");
        render(data.events || []);
      } catch {
        // ignore
      }
    });
  });

  // Initial load
  refresh();
}

main();
