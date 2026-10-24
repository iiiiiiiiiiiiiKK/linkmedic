import { classifyIp, isIpLiteral } from './ip';
import type { Transport } from './transport';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export class BlockedTargetError extends Error {
  readonly code = 'blocked_target';
  constructor(message: string) {
    super(message);
    this.name = 'BlockedTargetError';
  }
}

/**
 * Resolve a hostname and refuse the request unless *every* answer is a globally
 * routable unicast address.
 *
 * Rejecting on a single bad answer (instead of filtering it out) is deliberate:
 * a mixed answer set is exactly what a DNS-rebinding attempt looks like, and a
 * refused request is always safer than a request to "the other" record.
 */
export async function resolveAndValidate(transport: Transport, hostname: string): Promise<ResolvedAddress[]> {
  if (isIpLiteral(hostname)) {
    const verdict = classifyIp(hostname);
    if (!verdict) throw new BlockedTargetError('The target IP address could not be parsed.');
    if (!verdict.public) {
      throw new BlockedTargetError(
        `Refused to connect to ${verdict.normalized}: that address is ${verdict.reason}. Private, loopback, link-local and cloud-metadata addresses are blocked.`,
      );
    }
    return [{ address: verdict.normalized, family: verdict.version }];
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await transport.resolve(hostname);
  } catch {
    throw new BlockedTargetError(`DNS lookup for ${hostname} failed, so the target cannot be reached safely.`);
  }
  if (addresses.length === 0) {
    throw new BlockedTargetError(`DNS returned no usable address for ${hostname}.`);
  }

  for (const entry of addresses) {
    const verdict = classifyIp(entry.address);
    if (!verdict || !verdict.public) {
      throw new BlockedTargetError(
        `${hostname} resolves to a non-public address (${verdict?.reason ?? 'not routable'}). Private, loopback, link-local and cloud-metadata targets are blocked.`,
      );
    }
  }
  return addresses;
}
