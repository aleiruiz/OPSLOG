import { MFA_POLICIES, type MfaPolicy } from '../directory.js';
import { PlatformError, failure, success, type PlatformResponse } from './errors.js';
import type { PlatformKernel } from './kernel.js';
import type { SettingsInput, SettingsView } from './types.js';

export function settingsView(k: PlatformKernel, tenantId: string): SettingsView {
  const stored = k.settings.get(tenantId, 'Empresa');
  return {
    ...stored,
    name: k.tenantName(tenantId),
    status: k.tenants.status(tenantId) === 'active' ? 'active' : 'suspended',
  };
}

export async function getSettings(
  k: PlatformKernel,
  token: string,
  correlationId: string,
): Promise<PlatformResponse<SettingsView>> {
  try {
    const context = await k.authorize(token, correlationId, ['manage_config']);
    return success(settingsView(k, context.tenantId));
  } catch (error) {
    return failure(error);
  }
}

/**
 * Updates the caller's company settings (`manage_config`). Changing a security setting requires a
 * reason; it is validated but not stored (free text may carry personal data), and the change is audited.
 */
export async function updateSettings(
  k: PlatformKernel,
  token: string,
  correlationId: string,
  input: SettingsInput,
): Promise<PlatformResponse<SettingsView>> {
  try {
    const context = await k.authorize(token, correlationId, ['manage_config']);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const hours = input.sessionIdleHours;
    if (
      !name ||
      name.length > 160 ||
      !MFA_POLICIES.includes(input.mfa as MfaPolicy) ||
      typeof hours !== 'number' ||
      !Number.isInteger(hours) ||
      hours < 1 ||
      hours > 24
    )
      throw new PlatformError('invalid_input');
    const reason = input.reason;
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500))
      throw new PlatformError('invalid_input');
    const current = settingsView(k, context.tenantId);
    const securityChanged = current.mfa !== input.mfa || current.sessionIdleHours !== hours;
    if (securityChanged && !(typeof reason === 'string' && reason.trim()))
      throw new PlatformError('invalid_input');
    k.settings.set(context.tenantId, {
      name,
      mfa: input.mfa as MfaPolicy,
      sessionIdleHours: hours,
    });
    await k.auditNow(
      k.userActor(context),
      securityChanged ? 'tenant.security_settings_updated' : 'tenant.settings_updated',
      'tenant',
      context.tenantId,
      correlationId,
    );
    return success(settingsView(k, context.tenantId));
  } catch (error) {
    return failure(error);
  }
}
