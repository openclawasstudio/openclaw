const $ = (id) => document.getElementById(id);

const KEYS = {
  boardUrl: "mc.boardUrl",
  errorsUrl: "mc.errorsUrl"
};

function cfgGet() {
  return {
    boardUrl: localStorage.getItem(KEYS.boardUrl) || "",
    errorsUrl: localStorage.getItem(KEYS.errorsUrl) || ""
  };
}

function cfgSet(next) {
  localStorage.setItem(KEYS.boardUrl, next.boardUrl || "");
  localStorage.setItem(KEYS.errorsUrl, next.errorsUrl || "");
}

function cacheBust(url) {
  return url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderBoard(board) {
  const el = $("board");
  el.innerHTML = "";

  const columns = Array.isArray(board?.columns) ? board.columns : [];
  const cards = Array.isArray(board?.cards) ? board.cards : [];

  for (const col of columns) {
    const colEl = document.createElement("div");
    colEl.className = "col";
    colEl.dataset.colId = col.id;

    const inCol = cards.filter((c) => c.columnId === col.id);

    colEl.innerHTML = `
      <div class="colHead">
        <div class="colTitle">${escapeHtml(col.title)}</div>
        <div class="count">${inCol.length}</div>
      </div>
      <div class="cards" data-dropzone="${escapeHtml(col.id)}"></div>
    `;

    const cardsEl = colEl.querySelector(".cards");
    for (const c of inCol) {
      const cardEl = document.createElement("div");
      cardEl.className = "card";
      cardEl.draggable = true;
      cardEl.dataset.cardId = c.id;

      const badge = c.status ? `<span class="badge">${escapeHtml(c.status)}</span>` : "";
      const updated = c.updatedAt ? new Date(c.updatedAt).toLocaleString() : "";

      cardEl.innerHTML = `
        <div class="cardTitle">${escapeHtml(c.title)}</div>
        <div class="meta">
          <div>${badge}</div>
          <div>${escapeHtml(updated)}</div>
        </div>
      `;

      cardEl.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", c.id);
      });

      cardsEl.appendChild(cardEl);
    }

    // drop handling
    colEl.addEventListener("dragover", (e) => e.preventDefault());
    colEl.addEventListener("drop", (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData("text/plain");
      moveCard(id, col.id);
    });

    el.appendChild(colEl);
  }
}

let currentBoard = null;

function moveCard(cardId, columnId) {
  if (!currentBoard) return;
  const cards = currentBoard.cards || [];
  const c = cards.find((x) => x.id === cardId);
  if (!c) return;
  c.columnId = columnId;
  c.updatedAt = new Date().toISOString();
  renderBoard(currentBoard);
}

async function fetchJson(url) {
  const res = await fetch(cacheBust(url), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function refresh() {
  const cfg = cfgGet();

  // board
  if (!cfg.boardUrl) {
    currentBoard = {
      note: "Configure Board JSON URL",
      updatedAt: new Date().toISOString(),
      columns: [
        { id: "backlog", title: "Backlog" },
        { id: "doing", title: "Doing" },
        { id: "blocked", title: "Blocked" },
        { id: "done", title: "Done" }
      ],
      cards: [
        {
          id: "example-1",
          title: "Set Board JSON URL",
          columnId: "doing",
          status: "todo",
          updatedAt: new Date().toISOString()
        }
      ]
    };
    renderBoard(currentBoard);
  } else {
    try {
      currentBoard = await fetchJson(cfg.boardUrl);
      renderBoard(currentBoard);
    } catch (e) {
      currentBoard = null;
      $("board").innerHTML = `<div class="col"><div class="colTitle">Board load failed</div><p class="small">${escapeHtml(String(e))}</p></div>`;
    }
  }

  // errors
  if (!cfg.errorsUrl) {
    $("errors").textContent = "(configure an Errors JSON URL, then Refresh)";
    $("errorsUpdated").textContent = "—";
  } else {
    try {
      const err = await fetchJson(cfg.errorsUrl);
      const lines = Array.isArray(err?.lines) ? err.lines : [];
      $("errors").textContent = lines.join("\n") || "(no errors)";
      $("errorsUpdated").textContent = err?.updatedAt ? `Updated: ${new Date(err.updatedAt).toLocaleString()}` : "";
    } catch (e) {
      $("errors").textContent = `Errors load failed: ${String(e)}`;
      $("errorsUpdated").textContent = "";
    }
  }
}

function exportBoard() {
  if (!currentBoard) return;
  const blob = new Blob([JSON.stringify(currentBoard, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "board.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function wireModals() {
  const cfgDlg = $("cfg");
  const importDlg = $("importDlg");

  $("configBtn").addEventListener("click", () => {
    const cfg = cfgGet();
    $("cfgBoard").value = cfg.boardUrl;
    $("cfgErrors").value = cfg.errorsUrl;
    cfgDlg.showModal();
  });

  $("saveBtn").addEventListener("click", () => {
    cfgSet({
      boardUrl: $("cfgBoard").value.trim(),
      errorsUrl: $("cfgErrors").value.trim()
    });
    refresh();
  });

  $("importBtn").addEventListener("click", () => {
    $("importText").value = "";
    importDlg.showModal();
  });

  $("doImportBtn").addEventListener("click", () => {
    try {
      const data = JSON.parse($("importText").value);
      currentBoard = data;
      renderBoard(currentBoard);
    } catch (e) {
      alert("Invalid JSON: " + String(e));
    }
  });
}

function main() {
  $("refreshBtn").addEventListener("click", refresh);
  $("exportBtn").addEventListener("click", exportBoard);
  wireModals();
  refresh();
}

main();
