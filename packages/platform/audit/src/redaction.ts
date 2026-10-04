import type { AuditScalar } from './types.js';

const forbidden =
  /(?:password|secret|token|credential|authorization|cookie|email|phone|address|license|identification|document|cost|amount|ssn|curp|rfc)/i;

export function safeAuditMetadata(
  metadata: Readonly<Record<string, AuditScalar>> | undefined,
): Readonly<Record<string, AuditScalar>> {
  if (!metadata) return {};
  const safe: Record<string, AuditScalar> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (forbidden.test(key)) continue;
    if (typeof value === 'string' && forbidden.test(value)) continue;
    safe[key] = value;
  }
  return safe;
}
