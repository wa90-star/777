function queueMarketRecheck({ market, items, refreshContext = false, defer = (run) => setTimeout(run, 0) }) {
  if (!items?.length) return Promise.resolve({ suppressed: true, reason: "no-fresh-catalysts" });
  if (!market) return Promise.reject(new Error("Market recheck failed: engine unavailable"));

  return new Promise((resolve, reject) => {
    defer(async () => {
      const closed = () => ({ suppressed: true, reason: "market-window-closed" });
      try {
        if (!market.marketWindowOpen()) return resolve(closed());
        if (refreshContext) {
          await market.runContext();
          const context = market.getState();
          if (!context.marketWindowOpen) return resolve(closed());
          if (context.lastError) throw new Error(`Market context recheck failed: ${context.lastError}`);
        }
        // Re-read the live gate; no cached snapshots or force flag on retries.
        if (!market.marketWindowOpen()) return resolve(closed());
        await market.runCore();
        const core = market.getState();
        if (!core.marketWindowOpen) return resolve(closed());
        if (core.lastError) throw new Error(`Market core recheck failed: ${core.lastError}`);
        resolve({ completed: true, lastCoreScanAt: core.lastCoreScanAt || null });
      } catch (error) {
        reject(error);
      }
    });
  });
}

module.exports = queueMarketRecheck;
