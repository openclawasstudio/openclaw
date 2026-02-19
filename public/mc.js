const $ = (id) => document.getElementById(id);

const KEYS = {
  controlUrl: "mc.controlUrl",
  vercelUrl: "mc.vercelUrl",
  statusUrl: "mc.statusUrl"
};

function getCfg() {
  return {
    controlUrl: localStorage.getItem(KEYS.controlUrl) || "",
    vercelUrl: localStorage.getItem(KEYS.vercelUrl) || "",
    statusUrl: localStorage.getItem(KEYS.statusUrl) || ""
  };
}

function setCfg(next) {
  localStorage.setItem(KEYS.controlUrl, next.controlUrl || "");
  localStorage.setItem(KEYS.vercelUrl, next.vercelUrl || "");
  localStorage.setItem(KEYS.statusUrl, next.statusUrl || "");
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function pillFromBool(v) {
  if (v === true) return "OK";
  if (v === false) return "DOWN";
  return "—";
}

function applyLinks() {
  const cfg = getCfg();

  const control = $("tileControl");
  const vercel = $("tileVercel");

  if (cfg.controlUrl) {
    control.href = cfg.controlUrl;
    setText("controlUrl", cfg.controlUrl);
  } else {
    control.href = "#";
    setText("controlUrl", "(set in Configure)");
  }

  if (cfg.vercelUrl) {
    vercel.href = cfg.vercelUrl;
    setText("vercelUrl", cfg.vercelUrl);
  } else {
    vercel.href = "https://vercel.com/dashboard";
    setText("vercelUrl", "https://vercel.com/dashboard");
  }
}

function setMockStatus() {
  setText("gateway", "Unknown (static)");
  setText("discord", "Unknown (static)");
  setText("model", "—");
  setText("sessions", "—");
  setText("raw", "{");
  setText("lastUpdated", `Last updated: ${new Date().toLocaleString()}`);

  $("raw").textContent = JSON.stringify(
    {
      note: "Static dashboard. Configure a Status JSON URL to make Refresh pull live-ish data.",
      exampleShape: {
        gateway: { ok: true, url: "ws://127.0.0.1:18789" },
        discord: { ok: true },
        model: "openai-codex/gpt-5.2",
        sessions: 6
      }
    },
    null,
    2
  );

  $("note").textContent =
    "Tip: This is a static Vercel site. It can’t access your server’s localhost. If you want the Refresh button to show real status, publish a small JSON endpoint somewhere reachable (or later we add Vercel /api).";
}

function renderStatus(data) {
  const gatewayOk = data?.gateway?.ok;
  const discordOk = data?.discord?.ok;
  setText("gateway", gatewayOk === undefined ? "—" : gatewayOk ? "OK" : "DOWN");
  setText("discord", discordOk === undefined ? "—" : discordOk ? "OK" : "DOWN");
  setText("model", data?.model ?? "—");
  setText("sessions", data?.sessions?.toString?.() ?? "—");

  $("raw").textContent = JSON.stringify(data, null, 2);
  setText("lastUpdated", `Last updated: ${new Date().toLocaleString()}`);
  $("note").textContent = data?.note || "";
}

async function refresh() {
  const cfg = getCfg();

  if (!cfg.statusUrl) {
    setMockStatus();
    return;
  }

  try {
    setText("lastUpdated", "Last updated: fetching…");
    const res = await fetch(cfg.statusUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderStatus(data);
  } catch (err) {
    $("note").textContent = `Refresh failed: ${String(err)}. If this is a private URL or blocked by CORS, the browser can’t fetch it.`;
    setText("lastUpdated", `Last updated: ${new Date().toLocaleString()} (failed)`);
  }
}

function wireConfigModal() {
  const dlg = $("cfg");
  const cfgBtn = $("configBtn");

  cfgBtn.addEventListener("click", () => {
    const cfg = getCfg();
    $("cfgControl").value = cfg.controlUrl;
    $("cfgVercel").value = cfg.vercelUrl;
    $("cfgStatus").value = cfg.statusUrl;
    dlg.showModal();
  });

  $("saveBtn").addEventListener("click", () => {
    setCfg({
      controlUrl: $("cfgControl").value.trim(),
      vercelUrl: $("cfgVercel").value.trim(),
      statusUrl: $("cfgStatus").value.trim()
    });

    applyLinks();
    refresh();
  });
}

function wireCopyButtons() {
  const msg = $("copyMsg");
  document.querySelectorAll("button.cmd").forEach((b) => {
    b.addEventListener("click", async () => {
      const text = b.getAttribute("data-copy") || "";
      try {
        await navigator.clipboard.writeText(text);
        msg.textContent = `Copied: ${text}`;
      } catch {
        msg.textContent = `Copy failed. Manual: ${text}`;
      }
      setTimeout(() => (msg.textContent = ""), 1800);
    });
  });
}

function main() {
  applyLinks();
  wireConfigModal();
  wireCopyButtons();
  $("refreshBtn").addEventListener("click", refresh);
  setMockStatus();
}

main();
