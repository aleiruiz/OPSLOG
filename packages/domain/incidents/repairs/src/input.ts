import { Issues, idField, objectOf, present, versionField } from '../../cases/src/validation.js';

export function parseLink(input: unknown): { version: number; orderId: string } {
  const issues = new Issues();
  const data = objectOf(input, ['version', 'orderId'], issues);
  for (const key of ['version', 'orderId']) if (!present(data, key)) issues.add(key, 'required');
  const version = present(data, 'version') ? versionField(issues, data['version']) : undefined;
  const orderId = present(data, 'orderId')
    ? idField(issues, 'orderId', data['orderId'])
    : undefined;
  issues.throwIfAny();
  return { version: version as number, orderId: orderId as string };
}

export function parseUnlink(input: unknown): number {
  const issues = new Issues();
  const data = objectOf(input, ['version'], issues);
  if (!present(data, 'version')) issues.add('version', 'required');
  const version = present(data, 'version') ? versionField(issues, data['version']) : undefined;
  issues.throwIfAny();
  return version as number;
}
