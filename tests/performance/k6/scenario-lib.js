// Pieces shared by the k6 script (scenarios.js) and the Node driver (driver.ts): placeholder
// expansion and the percentile. Plain ES module with no imports, so k6 can load it.

/** Picks `list[(vu + iter) mod length]`: deterministic, different for every virtual user. */
export function pick(list, vu, iter) {
  return list[(vu * 7919 + iter) % list.length];
}

/**
 * Replaces `{name}` in a string. `{vu}` and `{iter}` come from the virtual user; the others from the
 * fixture (`run`, a tag that differs on every run so writes never collide with an earlier run; `areaId`, a single value; `vehicleId`, `platePrefix`, `plateInfix`, lists picked per user).
 */
export function expand(template, fixture, vu, iter) {
  return template.replace(/\{(\w+)\}/g, (_match, name) => {
    if (name === 'vu') return String(vu);
    if (name === 'iter') return String(iter);
    if (name === 'run') return String(fixture.run ?? '0000');
    const value =
      fixture[
        name === 'vehicleId'
          ? 'vehicleIds'
          : name === 'platePrefix'
            ? 'platePrefixes'
            : name === 'plateInfix'
              ? 'plateInfixes'
              : name
      ];
    if (Array.isArray(value)) return String(pick(value, vu, iter));
    if (value === undefined) throw new Error(`unknown placeholder ${name}`);
    return String(value);
  });
}

/** The body of a scenario with every string value expanded (null and numbers pass through). */
export function expandBody(body, fixture, vu, iter) {
  if (body === undefined) return undefined;
  const walk = (value) => {
    if (typeof value === 'string') return expand(value, fixture, vu, iter);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, inner] of Object.entries(value)) out[key] = walk(inner);
      return out;
    }
    return value;
  };
  return JSON.stringify(walk(body));
}

/** Nearest-rank percentile (the k6 trend uses interpolation; for the tolerances here they agree). */
export function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
