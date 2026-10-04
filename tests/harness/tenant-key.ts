export function tenantKey(tenant: string, id: number): string {
  if (!tenant) throw new Error('tenant is required');
  return `${tenant}:${id}`;
}
