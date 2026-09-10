const byId = (id) => document.getElementById(id);

function formatTime(value) {
  if (!value) return "–";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "–" : d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function formatNumber(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "–";
}

function renderSignals(signals) {
  const root = byId("signals");
  if (!Array.isArray(signals) || signals.length === 0) {
    root.textContent = "Keine Signale verfügbar.";
    return;
  }

  root.replaceChildren();

  for (const signal of signals) {
    const card = document.createElement("div");
    card.className = "signal";

    const top = document.createElement("div");
    top.className = "signal-top";

    const symbol = document.createElement("strong");
    symbol.textContent = signal.symbol || "–";

    const direction = document.createElement("span");
    direction.className = "direction " + (signal.direction === "LONG" ? "long" : signal.direction === "SHORT" ? "short" : "none");
    direction.textContent = signal.direction || "KEIN SIGNAL";

    top.append(symbol, direction);

    const stats = document.createElement("div");
    stats.className = "stats";
    stats.textContent = `Preis ${formatNumber(signal.price)} · Bewegung ${formatNumber(signal.percentChange)}% · Volumen ${formatNumber(signal.volumeRatio)}x · Score ${signal.score || 0}/100`;

    card.append(top, stats);
    root.append(card);
  }
}

async function loadStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    const data = await response.json();
    byId("status").textContent = data.status === "online" ? "System online" : "Systemstatus unbekannt";
    byId("telegram").textContent = data.telegramConfigured ? "Telegram aktiv" : "Telegram aus";
    byId("interval").textContent = data.autoScanMinutes ? `${data.autoScanMinutes} Min` : "–";
    byId("lastScan").textContent = formatTime(data.lastAutoScanAt);
  } catch {
    byId("status").textContent = "Verbindung gestört";
  }
}

async function loadScan() {
  const button = byId("refresh");
  button.disabled = true;
  try {
    const response = await fetch("/api/scan", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || data.error || "Scannerfehler");
    renderSignals(data.signals);
  } catch (error) {
    byId("signals").textContent = error.message || "Scannerfehler";
  } finally {
    button.disabled = false;
  }
}

byId("refresh").addEventListener("click", async () => {
  await loadScan();
  await loadStatus();
});

loadStatus();
loadScan();
setInterval(loadStatus, 30000);
