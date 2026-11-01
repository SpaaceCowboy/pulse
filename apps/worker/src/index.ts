// Entry point. PROBE_ONLY=1 runs the stateless second-vantage probe (no Postgres, no Redis, no alerts);
// anything else runs the full worker.
export {}
if (process.env.PROBE_ONLY === '1') await import('./probe')
else await import('./main')
