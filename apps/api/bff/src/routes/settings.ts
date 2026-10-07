import { route, reply, body, bad, type Route } from './shared.js';

const SETTINGS_KEYS = ['name', 'mfa', 'sessionIdleHours', 'reason'] as const;

export const SETTINGS_ROUTES: readonly Route[] = [
  route('company.settings.get', async (ctx) =>
    reply(
      ctx,
      'company.settings.get',
      await ctx.platform.getSettings(ctx.token as string, ctx.correlationId),
      (v) => v,
    ),
  ),
  route('company.settings.update', async (ctx) => {
    const input = body(ctx, SETTINGS_KEYS, ['name', 'mfa', 'sessionIdleHours']);
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'company.settings.update',
      await ctx.platform.updateSettings(ctx.token as string, ctx.correlationId, {
        name: input['name'],
        mfa: input['mfa'],
        sessionIdleHours: input['sessionIdleHours'],
        ...(Object.hasOwn(input, 'reason') ? { reason: input['reason'] } : {}),
      }),
      (v) => v,
    );
  }),
];
