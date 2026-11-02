import { NoPermissionError } from '@tryghost/errors';

export type StaffAuthPolicy =
  | { mode: 'password' }
  | { mode: 'oidc'; status: 'ready' | 'unavailable'; providerKey?: string }
  | { mode: 'unavailable' };

let currentPolicy: StaffAuthPolicy = { mode: 'password' };

export function setStaffAuthPolicy(policy: StaffAuthPolicy) {
  currentPolicy = policy;
}

export function getStaffAuthPolicy(): StaffAuthPolicy {
  return currentPolicy;
}

export function assertPasswordAuthenticationAllowed(): void {
  if (currentPolicy.mode !== 'password') {
    throw new NoPermissionError({
      code: 'STAFF_PASSWORD_AUTH_DISABLED',
      message: 'Password authentication is disabled for staff users.',
    });
  }
}
