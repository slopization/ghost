import { hkdfSync } from 'node:crypto';
import { BadRequestError, InternalServerError } from '@tryghost/errors';
import { z } from 'zod';
import type { Request, Response } from 'express';

const COOKIE_NAME = 'ghost-admin-oidc-transaction';
const MAX_COOKIE_SIZE = 3800;
const TRANSACTION_TTL_SECONDS = 5 * 60;

const transactionSchema = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
  codeVerifier: z.string().min(1),
  returnTo: z.string(),
  providerKey: z.string().length(64),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type OidcTransaction = z.infer<typeof transactionSchema>;

export function deriveTransactionKey(secret: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', secret, '', 'ghost-admin-oidc-transaction', 32));
}

export function createTransaction(
  library: typeof import('openid-client'),
  returnTo: string,
  providerKey: string,
): OidcTransaction {
  const now = Math.floor(Date.now() / 1000);
  return {
    state: library.randomState(),
    nonce: library.randomNonce(),
    codeVerifier: library.randomPKCECodeVerifier(),
    returnTo,
    providerKey,
    iat: now,
    exp: now + TRANSACTION_TTL_SECONDS,
  };
}

function cookieOptions(path: string, secure: boolean) {
  return { httpOnly: true, sameSite: 'lax' as const, secure, path };
}

export async function writeTransactionCookie(
  res: Response,
  transaction: OidcTransaction,
  key: Uint8Array,
  path: string,
  secure: boolean,
) {
  const { EncryptJWT } = await import('jose');
  const value = await new EncryptJWT(transaction)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt(transaction.iat)
    .setExpirationTime(transaction.exp)
    .encrypt(key);
  if (value.length > MAX_COOKIE_SIZE) {
    throw new InternalServerError({
      code: 'OIDC_TRANSACTION_TOO_LARGE',
      message: 'The OIDC transaction is too large.',
    });
  }
  res.cookie(COOKIE_NAME, value, {
    ...cookieOptions(path, secure),
    maxAge: TRANSACTION_TTL_SECONDS * 1000,
  });
}

function readCookie(req: Request): string {
  const matches = (req.headers.cookie || '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${COOKIE_NAME}=`));
  if (matches.length !== 1) {
    throw new BadRequestError({
      code: 'OIDC_TRANSACTION_COOKIE_INVALID',
      message: 'The OIDC transaction cookie is invalid.',
    });
  }
  return decodeURIComponent(matches[0].slice(COOKIE_NAME.length + 1));
}

export async function readTransactionCookie(
  req: Request,
  key: Uint8Array,
  providerKey: string,
): Promise<OidcTransaction> {
  const { jwtDecrypt } = await import('jose');
  const { payload } = await jwtDecrypt(readCookie(req), key, {
    keyManagementAlgorithms: ['dir'],
    contentEncryptionAlgorithms: ['A256GCM'],
  });
  const transaction = transactionSchema.parse(payload);
  const now = Math.floor(Date.now() / 1000);
  if (transaction.exp <= now || transaction.iat > now || transaction.providerKey !== providerKey) {
    throw new BadRequestError({
      code: 'OIDC_TRANSACTION_INVALID',
      message: 'The OIDC transaction is invalid.',
    });
  }
  return transaction;
}

export function clearTransactionCookie(res: Response, path: string, secure: boolean) {
  res.clearCookie(COOKIE_NAME, cookieOptions(path, secure));
}
