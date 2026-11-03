// Timing text stays a browser preference. API values retain their native units.
const units = { hz: { frequency: true, scale: 1 }, khz: { frequency: true, scale: 1000 },
  s: { denominator: 1 }, ms: { denominator: 1000 }, us: { denominator: 1000000 }, 'µs': { denominator: 1000000 }, 'μs': { denominator: 1000000 } };
const canonical = unit => ({ hz: 'Hz', s: 's', ms: 'ms' })[String(unit).trim().toLowerCase()] || null;

export function canonicalTimeUnit(parameter) {
  if (typeof parameter === 'object' && parameter?.unit != null && String(parameter.unit).trim()) return canonical(parameter.unit);
  const path = String(typeof parameter === 'string' ? parameter : parameter?.path || '').split('.').at(-1);
  // Angular/linear velocity and torque units are not timing fields, even when
  // their conventional serialized spelling happens to end with "_s".
  if (/(?:^|_)(?:rad|m|nm)_s$/i.test(path)) return null;
  const suffix = path.match(/(?:^|_)(hz|ms|s)$/i)?.[1];
  return suffix ? canonical(suffix) : null;
}

export function parseTimeValue(raw, { unit = 's', min, max, minExclusive = false, maxExclusive = false,
  nullable = false, allowFrequency = true, label = 'Value' } = {}) {
  const target = canonical(unit);
  if (!target) throw new Error(`Unsupported canonical time unit: ${unit}`);
  const text = raw == null ? '' : String(raw).trim();
  if (nullable && (text === '' || text.toLowerCase() === 'none')) return null;
  const match = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([a-zµμ]*)$/i);
  const source = match && units[(match[2] || target).toLowerCase()];
  if (!match || !source || (source.frequency && !allowFrequency)) {
    throw new Error(`${label}: enter a number${allowFrequency ? ' in Hz, kHz, s, ms or µs' : ' in s, ms or µs'}; bare numbers use ${target}.`);
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) throw new Error(`${label} must be finite.`);
  if (source.frequency && amount <= 0 || target === 'Hz' && amount <= 0) throw new Error(`${label}: frequency and its period must be positive.`);
  let value;
  if (source.frequency) value = target === 'Hz' ? amount * source.scale : units[target].denominator / (amount * source.scale);
  else if (target === 'Hz') value = source.denominator / amount;
  else {
    const ratio = source.denominator / units[target].denominator;
    value = ratio >= 1 ? amount / ratio : amount * (1 / ratio);
  }
  if (!Number.isFinite(value) || (amount !== 0 && value === 0)) throw new Error(`${label} is outside the finite timing range.`);
  if (min != null && (minExclusive ? value <= min : value < min)) throw new Error(`${label} must be ${minExclusive ? 'greater than' : 'at least'} ${min} ${target}.`);
  if (max != null && (maxExclusive ? value >= max : value > max)) throw new Error(`${label} must be ${maxExclusive ? 'less than' : 'at most'} ${max} ${target}.`);
  return value;
}

export function configureTimeInput(input, options = {}) {
  const unit = canonical(options.unit || 's');
  if (!unit) throw new Error(`Unsupported canonical time unit: ${options.unit}`);
  input.type = 'text'; input.inputMode = 'decimal'; input.spellcheck = false;
  input.dataset.timeUnit = unit;
  const tip = options.allowFrequency === false ? `Accepts s, ms or µs. Bare numbers use ${unit}.` : `Accepts 50 Hz or 20 ms. Bare numbers use ${unit}.`;
  if (!input.title?.includes(tip)) input.title = [input.title, tip].filter(Boolean).join('\n');
  return input;
}

export function readTimeInput(input, options = {}) {
  try {
    const value = parseTimeValue(input.value, options);
    input.setCustomValidity?.('');
    return value;
  } catch (error) { input.setCustomValidity?.(error.message); throw error; }
}

export function setTimeInputValue(input, value, { force = false, ...options } = {}) {
  // Validate the canonical value independently of the user's display spelling.
  const next = parseTimeValue(value, options);
  if (!force) {
    try {
      const current = parseTimeValue(input.value, options);
      if (current === next || (current != null && next != null && Math.abs(current - next) <= Math.max(Math.abs(current), Math.abs(next)) * 1e-12)) {
        input.setCustomValidity?.(''); return false;
      }
    } catch { /* Keep a focused partial edit; a later read reports its validity. */ }
    if (input.ownerDocument?.activeElement === input) return false;
  }
  input.value = next == null ? '' : String(next);
  input.setCustomValidity?.('');
  return true;
}
