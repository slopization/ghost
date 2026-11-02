import type { NextFunction, Request, Response } from 'express';
import { BadRequestError } from '@tryghost/errors';
import oidc from '../../../auth/oidc';
import { buildLoginUrl, validateAuthorizationResponse } from '../../../auth/oidc/client';
import { resolveActiveStaff, resolveVerifiedEmail } from '../../../auth/oidc/identity';
import { getAdminRedirect, normalizeReturnTo } from '../../../auth/oidc/redirect';
import {
  clearTransactionCookie,
  createTransaction,
  readTransactionCookie,
  writeTransactionCookie,
} from '../../../auth/oidc/transaction';
import urlUtils from '../../../../shared/url-utils';

const express = require('../../../../shared/express');

const CALLBACK_PARAMETERS = new Set([
  'code',
  'state',
  'iss',
  'scope',
  'error',
  'error_description',
  'error_uri',
  'session_state',
]);

function setSecurityHeaders(res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function getSingleQuery(req: Request, name: string): string | undefined {
  const requestUrl = new URL(req.originalUrl, 'http://ignored.example');
  const values = requestUrl.searchParams.getAll(name);
  if (values.length > 1) {
    throw new BadRequestError({
      code: 'OIDC_DUPLICATE_PARAMETER',
      message: 'The OIDC response contains a duplicate parameter.',
    });
  }
  return values[0];
}

function assertValidCallbackQuery(req: Request) {
  const requestUrl = new URL(req.originalUrl, 'http://ignored.example');
  for (const name of requestUrl.searchParams.keys()) {
    if (!CALLBACK_PARAMETERS.has(name) || requestUrl.searchParams.getAll(name).length > 1) {
      throw new BadRequestError({
        code: 'OIDC_INVALID_CALLBACK_QUERY',
        message: 'The OIDC callback query is invalid.',
      });
    }
  }
}

function assertValidStartQuery(req: Request) {
  const requestUrl = new URL(req.originalUrl, 'http://ignored.example');
  for (const name of requestUrl.searchParams.keys()) {
    if (name !== 'returnTo' || requestUrl.searchParams.getAll(name).length > 1) {
      throw new BadRequestError({
        code: 'OIDC_INVALID_START_QUERY',
        message: 'The OIDC start query is invalid.',
      });
    }
  }
}

function redirectError(res: Response, adminUrl: string, code: string) {
  res.redirect(303, getAdminRedirect(adminUrl, '/', code));
}

function isAvailabilityError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = 'code' in current && typeof current.code === 'string' ? current.code : '';
    if (code.startsWith('ECONN') || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

function getErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';
}

export function createOidcRouter() {
  const router = express.Router('staff-oidc');
  const shared = require('../../shared');
  const auth = require('../../../auth');
  const models = require('../../../models');

  router.use(shared.middleware.urlRedirects.adminSSLAndHostRedirect);
  router.use((_req: Request, res: Response, next: NextFunction) => {
    setSecurityHeaders(res);
    next();
  });

  router.get(
    '/start/',
    shared.middleware.brute.globalBlock,
    async (req: Request, res: Response) => {
      const service = oidc.service;
      if (
        service.policy.mode !== 'oidc' ||
        service.policy.status !== 'ready' ||
        !service.client ||
        !service.urls ||
        !service.providerKey ||
        !service.transactionKey
      ) {
        const adminUrl = service.urls?.adminUrl || urlUtils.urlFor('admin', true);
        return redirectError(res, adminUrl, 'oidc_unavailable');
      }

      try {
        await auth.setup.assertSetupCompleted(true)();
        assertValidStartQuery(req);
        const rawReturnTo = getSingleQuery(req, 'returnTo');
        const transaction = createTransaction(
          service.client.library,
          normalizeReturnTo(rawReturnTo),
          service.providerKey,
        );
        await writeTransactionCookie(
          res,
          transaction,
          service.transactionKey,
          service.urls.transactionPath,
          service.urls.callbackUrl.startsWith('https:'),
        );
        const authorizationUrl = await buildLoginUrl(
          service.client,
          service.urls.callbackUrl,
          transaction,
        );
        return res.redirect(302, authorizationUrl.toString());
      } catch (error) {
        return redirectError(
          res,
          service.urls.adminUrl,
          getErrorCode(error) === 'OIDC_INVALID_START_QUERY'
            ? 'oidc_invalid_response'
            : 'oidc_unavailable',
        );
      }
    },
  );

  router.get('/callback/', async (req: Request, res: Response) => {
    const service = oidc.service;
    if (!service.urls) {
      const adminUrl = urlUtils.urlFor('admin', true);
      const path = `${urlUtils.getSubdir()}/ghost/auth/oidc`;
      clearTransactionCookie(res, path, new URL(adminUrl).protocol === 'https:');
      return redirectError(res, adminUrl, 'oidc_unavailable');
    }

    const secure = service.urls.callbackUrl.startsWith('https:');
    clearTransactionCookie(res, service.urls.transactionPath, secure);
    if (
      service.policy.mode !== 'oidc' ||
      service.policy.status !== 'ready' ||
      !service.client ||
      !service.providerKey ||
      !service.transactionKey
    ) {
      return redirectError(res, service.urls.adminUrl, 'oidc_unavailable');
    }

    try {
      assertValidCallbackQuery(req);
      const transaction = await readTransactionCookie(
        req,
        service.transactionKey,
        service.providerKey,
      );
      const providerError = getSingleQuery(req, 'error');
      if (providerError) {
        if (getSingleQuery(req, 'state') !== transaction.state) {
          return redirectError(res, service.urls.adminUrl, 'oidc_invalid_response');
        }
        const code =
          providerError === 'access_denied'
            ? 'oidc_cancelled'
            : providerError === 'server_error' || providerError === 'temporarily_unavailable'
              ? 'oidc_unavailable'
              : 'oidc_invalid_response';
        return redirectError(res, service.urls.adminUrl, code);
      }

      const query = new URL(req.originalUrl, 'http://ignored.example').search;
      const tokens = await validateAuthorizationResponse(
        service.client,
        service.urls.callbackUrl,
        query,
        transaction,
      );
      const email = await resolveVerifiedEmail(service.client, tokens);
      const user = await resolveActiveStaff(models, email);
      await auth.session.sessionService.createOidcSessionForUser(req, res, user, {
        providerKey: service.providerKey,
      });
      return res.redirect(303, getAdminRedirect(service.urls.adminUrl, transaction.returnTo));
    } catch (error) {
      const errorCode = getErrorCode(error);
      const code =
        errorCode.startsWith('OIDC_EMAIL_') || errorCode === 'OIDC_STAFF_ACCESS_DENIED'
          ? 'oidc_access_denied'
          : isAvailabilityError(error)
            ? 'oidc_unavailable'
            : 'oidc_invalid_response';
      return redirectError(res, service.urls.adminUrl, code);
    }
  });

  return router;
}

export default createOidcRouter;
