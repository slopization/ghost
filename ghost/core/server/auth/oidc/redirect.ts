import { createHash } from 'node:crypto';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type OidcUrls = {
  startUrl: string;
  callbackUrl: string;
  transactionPath: string;
  adminUrl: string;
};

export function normalizeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    return '/';
  }
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return '/';
  }

  const path = value.split(/[?#]/, 1)[0].toLowerCase();
  if (
    path === '/signin' ||
    path.startsWith('/signin/') ||
    path === '/signout' ||
    path.startsWith('/auth/')
  ) {
    return '/';
  }

  return value;
}

export function getOidcUrls(urlUtils: {
  urlFor(name: 'admin', absolute: true): string;
  getSubdir(): string;
}): OidcUrls {
  const adminUrl = urlUtils.urlFor('admin', true);
  const origin = new URL(adminUrl).origin;
  const transactionPath = `${urlUtils.getSubdir()}/ghost/auth/oidc` || '/ghost/auth/oidc';

  return {
    adminUrl,
    transactionPath,
    startUrl: `${origin}${transactionPath}/start/`,
    callbackUrl: `${origin}${transactionPath}/callback/`,
  };
}

export function getProviderKey(issuer: string, clientId: string, callbackUrl: string): string {
  return createHash('sha256').update(`${issuer}\0${clientId}\0${callbackUrl}`).digest('hex');
}

export function getAdminRedirect(adminUrl: string, returnTo: string, error?: string): string {
  const url = new URL(adminUrl);
  url.hash = error
    ? `#/signin?error=${encodeURIComponent(error)}`
    : `#${normalizeReturnTo(returnTo)}`;
  return url.toString();
}
