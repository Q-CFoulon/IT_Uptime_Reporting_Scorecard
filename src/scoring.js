// Health Index — transparent, bounded, rate-based. Every sub-score is 0..100 and the
// index is their configured weighted average. See README "Health Index calibration".

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

// Uptime is scored RELATIVE TO THE SLA TARGET, not an absolute 100%.
//   actual >= target            -> 100
//   actual <= target - floor    -> 0   (floor defaults to 2 percentage points)
//   in between                  -> linear
export function uptimeSubScore(actualPct, targetPct, floorBelowTargetPct) {
  const floor = targetPct - floorBelowTargetPct;
  if (actualPct >= targetPct) return 100;
  if (actualPct <= floor) return 0;
  return clamp((actualPct - floor) / (targetPct - floor) * 100);
}

// Disk is piecewise on the worst array: 100 at 0% used, ~60 at warn, ~20 at crit, 0 at 100%.
export function diskSubScore(worstPct, warnPct, critPct) {
  if (worstPct == null) return 100;
  if (worstPct <= warnPct) return clamp(100 - (worstPct / warnPct) * 40);          // 100 -> 60
  if (worstPct <= critPct) return clamp(60 - ((worstPct - warnPct) / (critPct - warnPct)) * 40); // 60 -> 20
  return clamp(20 - ((worstPct - critPct) / (100 - critPct)) * 20);                 // 20 -> 0
}

// Security uses INTERVENTIONS (confirmed incidents) as the real signal, capped, plus a
// small escalation-RATE term. This no longer zeroes out at high IDS escalation volumes.
export function securitySubScore(totals, cfg) {
  const s = cfg.security;
  const intPenalty = Math.min(s.maxInterventionPenalty, (totals.int || 0) * s.pointsPerIntervention);
  const escRate = totals.dp > 0 ? (totals.esc / totals.dp) * 1000 : 0; // escalations per 1,000 data points
  const escPenalty = Math.min(s.maxEscalationPenalty, escRate * s.escalationRatePer1000);
  return clamp(100 - intPenalty - escPenalty);
}

export function healthIndex(cfg, { uptimePct, uptimeTargetPct, worstDiskPct, eventTotals }) {
  const w = cfg.weights;
  const up = uptimeSubScore(uptimePct, uptimeTargetPct, cfg.uptime.floorBelowTargetPct);
  const disk = diskSubScore(worstDiskPct, cfg.disk.warnPct, cfg.disk.critPct);
  const sec = securitySubScore(eventTotals, cfg);
  const wsum = (w.uptime + w.disk + w.security) || 1;
  const index = (up * w.uptime + disk * w.disk + sec * w.security) / wsum;
  return { index: +index.toFixed(1), subScores: { uptime: +up.toFixed(1), disk: +disk.toFixed(1), security: +sec.toFixed(1) }, weights: w };
}
