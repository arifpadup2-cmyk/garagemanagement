# Live probe evidence — 2026-07-26 (non-destructive, localhost:3010)

## Concurrency (atomic payment endpoint)
Two payments of 60 fired concurrently at one 100-total invoice:
- pay #1 → accepted (totalPaid 60)
- pay #2 → **rejected**: "Payment exceeds outstanding balance — 40.00 due."
- final: totalPaid=60, payments=1
→ Row-locked serialization CONFIRMED working; the classic lost-update/overpay race is closed.

## Full-collection fetch latency (Neon round-trip bound)
customers 6r/676ms · invoices 3r/762ms · transactions 7r/768ms · jobCards 6r/644ms
→ ~650–770ms per collection even at ~single-digit rows = Neon network RTT dominates.
parts 514r/1323ms → linear growth with row count (payload + serialization).
Perf agent then loaded ~1,176 ZZPERF-* parts to benchmark; latency climbs with N.

## Connection pool (max:8)
50 concurrent GET /api/invoices → 1380ms total (queued through 8 conns, no errors).
→ Fine at 50; the SPA's load-entire-collection-on-login model is the real scale risk,
   not the pool. See performance-db.md.

## Cleanup
Throwaway probe invoice deleted. ZZPERF-* perf-test parts to be swept post-audit.
