// Business-hours helpers. All logic works in the "business timezone" defined by
// businessHours.timezoneOffsetMinutes (minutes to ADD to UTC, e.g. -360 = UTC-6/CST).

export function toBusinessDate(epochMs, offsetMin) {
  return new Date(epochMs + offsetMin * 60000);
}

// Is the given instant inside the configured working window?
export function inBusinessHours(epochMs, bh) {
  const d = toBusinessDate(epochMs, bh.timezoneOffsetMinutes);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat, evaluated in business tz
  if (!bh.days.includes(dow)) return false;
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  return hour >= bh.startHour && hour < bh.endHour;
}

// Total business hours between two instants (used as a reference / sanity value).
export function businessHoursInRange(startMs, endMs, bh) {
  const stepMin = 15;
  let hours = 0;
  for (let t = startMs; t < endMs; t += stepMin * 60000) {
    if (inBusinessHours(t, bh)) hours += stepMin / 60;
  }
  return hours;
}

// Period "YYYY-MM" -> [startMs, endMs) in UTC, aligned to the business tz month.
export function periodRange(period, offsetMin) {
  const [y, m] = period.split('-').map(Number);
  const startLocal = Date.UTC(y, m - 1, 1, 0, 0, 0);
  const endLocal = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 0, 0, 0);
  // Convert the local-month boundaries back to real UTC instants.
  return { startMs: startLocal - offsetMin * 60000, endMs: endLocal - offsetMin * 60000 };
}

export function currentPeriod(offsetMin) {
  const d = new Date(Date.now() + offsetMin * 60000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function previousPeriod(offsetMin) {
  const d = new Date(Date.now() + offsetMin * 60000);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
