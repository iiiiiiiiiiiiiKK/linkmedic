import { json } from '../lib/http';

/**
 * Liveness probe. Kept intentionally cheap: it must stay green even when the
 * outbound network or KV is unavailable.
 */
export const onRequestGet = async (context: { env: Record<string, unknown> }): Promise<Response> => {
  return json({
    status: 'ok',
    service: 'linkmedic',
    version: '1.0.0',
    runtime: 'cloudflare-workers',
    capabilities: {
      // What this deployment can actually do, so the UI can be honest about it.
      ipPinning: false,
      certificateDetails: false,
      certificateVerdict: true,
      linkChecking: true,
      history: false,
      sameOriginFilter: true,
    },
    limits: {
      rateLimitPerMinute: Number(context.env.LINKMEDIC_RATE_LIMIT ?? 20),
      maxLinks: Number(context.env.LINKMEDIC_MAX_LINKS ?? 25),
      rateLimitEnforced: Boolean(context.env.LINKMEDIC_KV),
    },
  });
};
