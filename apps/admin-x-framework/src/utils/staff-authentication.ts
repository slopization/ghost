import type { SiteData, StaffAuthentication } from '../api/site';
import { getGhostPaths } from './helpers';

export function getStaffAuthentication(site: SiteData): StaffAuthentication {
  const value: unknown = site.staff_authentication;
  if (value === undefined) {
    return { mode: 'password' };
  }
  if (!value || typeof value !== 'object' || !('mode' in value)) {
    return { mode: 'unavailable' };
  }
  if (value.mode === 'password') {
    return { mode: 'password' };
  }
  if (value.mode === 'unavailable') {
    return { mode: 'unavailable' };
  }
  if (
    value.mode !== 'oidc' ||
    !('status' in value) ||
    (value.status !== 'ready' && value.status !== 'unavailable') ||
    !('provider_name' in value) ||
    typeof value.provider_name !== 'string' ||
    !value.provider_name ||
    !('start_url' in value) ||
    typeof value.start_url !== 'string'
  ) {
    return { mode: 'unavailable' };
  }
  return {
    mode: 'oidc',
    status: value.status,
    provider_name: value.provider_name,
    start_url: value.start_url,
  };
}

export function isOidcOnlyAuthentication(authentication: StaffAuthentication): boolean {
  return authentication.mode === 'oidc';
}

export function buildOidcStartUrl(authentication: StaffAuthentication, returnTo: string): string {
  if (authentication.mode !== 'oidc' || authentication.status !== 'ready') {
    throw new Error('OIDC authentication is unavailable');
  }

  const url = new URL(authentication.start_url);
  const expectedPath = `${getGhostPaths().subdir}/ghost/auth/oidc/start/`;
  if (
    url.origin !== window.location.origin ||
    url.pathname !== expectedPath ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new Error('Invalid OIDC start URL');
  }
  url.searchParams.set('returnTo', returnTo);
  return url.toString();
}
