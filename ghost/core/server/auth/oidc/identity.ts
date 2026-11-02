import { z } from 'zod';
import { BadRequestError, NoPermissionError } from '@tryghost/errors';
import type { OidcClient } from './client';

const emailSchema = z.string().email();

type Claims = Record<string, unknown>;

function getVerifiedEmail(claims: Claims): string | null {
  if (claims.email_verified !== true || !emailSchema.safeParse(claims.email).success) {
    return null;
  }
  return claims.email as string;
}

export async function resolveVerifiedEmail(
  client: OidcClient,
  tokens: Awaited<ReturnType<OidcClient['library']['authorizationCodeGrant']>>,
): Promise<string> {
  const claims = tokens.claims() as Claims | undefined;
  if (!claims || typeof claims.sub !== 'string') {
    throw new BadRequestError({
      code: 'OIDC_INVALID_IDENTITY',
      message: 'The OIDC identity response is invalid.',
    });
  }

  const idTokenEmail = getVerifiedEmail(claims);
  if (idTokenEmail) {
    return idTokenEmail;
  }
  if (
    claims.email_verified === false ||
    (claims.email_verified !== undefined && claims.email_verified !== true)
  ) {
    throw new NoPermissionError({
      code: 'OIDC_EMAIL_NOT_VERIFIED',
      message: 'The OIDC email address is not verified.',
    });
  }
  if (!tokens.access_token) {
    throw new BadRequestError({
      code: 'OIDC_EMAIL_CLAIMS_MISSING',
      message: 'The OIDC email claims are missing.',
    });
  }

  const userInfo = await client.library.fetchUserInfo(
    client.configuration,
    tokens.access_token,
    claims.sub,
  );
  const userInfoEmail = getVerifiedEmail(userInfo as Claims);
  if (!userInfoEmail) {
    throw new NoPermissionError({
      code: 'OIDC_EMAIL_NOT_VERIFIED',
      message: 'The OIDC email address is not verified.',
    });
  }
  if (
    typeof claims.email === 'string' &&
    claims.email.toLowerCase() !== userInfoEmail.toLowerCase()
  ) {
    throw new NoPermissionError({
      code: 'OIDC_EMAIL_MISMATCH',
      message: 'The OIDC email claims do not match.',
    });
  }

  return userInfoEmail;
}

export async function resolveActiveStaff(models: any, email: string) {
  const user = await models.User.getByEmail(email);
  if (!user || !user.isActive()) {
    throw new NoPermissionError({
      code: 'OIDC_STAFF_ACCESS_DENIED',
      message: 'The OIDC identity is not an active staff user.',
    });
  }
  return user;
}
