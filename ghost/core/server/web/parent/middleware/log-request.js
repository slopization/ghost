const logging = require('@tryghost/logging');
const config = require('../../../../shared/config');

const OIDC_PATH = /\/ghost\/auth\/oidc\/(?:start|callback)\/?(?:\?|$)/i;

function sanitizeOidcLocation(location) {
  if (typeof location !== 'string') {
    return location;
  }
  try {
    const url = new URL(location, 'http://ignored.example');
    url.search = '';
    if (url.hash.includes('?')) {
      url.hash = url.hash.slice(0, url.hash.indexOf('?'));
    }
    return url.origin === 'http://ignored.example' ? `${url.pathname}${url.hash}` : url.toString();
  } catch (error) {
    return '[redacted-oidc-location]';
  }
}

function getLogObjects(req, res) {
  if (!OIDC_PATH.test(req.originalUrl || req.url || '')) {
    return { req, res };
  }

  const pathname = (req.originalUrl || req.url).split('?')[0];
  const headers = { ...req.headers };
  delete headers.cookie;
  delete headers['x-original-uri'];
  const responseHeaders = { ...res.getHeaders() };
  if (responseHeaders.location) {
    responseHeaders.location = sanitizeOidcLocation(responseHeaders.location);
  }

  return {
    req: {
      requestId: req.requestId,
      userId: req.userId,
      url: pathname,
      originalUrl: pathname,
      method: req.method,
      params: {},
      query: {},
      headers,
    },
    res: {
      statusCode: res.statusCode,
      responseTime: res.responseTime,
      getHeaders() {
        return responseHeaders;
      },
    },
  };
}

/**
 * @TODO: move this middleware to Framework monorepo?
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
module.exports = function logRequest(req, res, next) {
  const startTime = Date.now();

  function logResponse() {
    // 'close' before 'finish' means the client went away before we responded
    if (!res.writableFinished) {
      res.statusCode = 499;
    }

    res.responseTime = Date.now() - startTime + 'ms';
    req.userId = req.user ? (req.user.id ? req.user.id : req.user) : null;
    const logged = getLogObjects(req, res);

    if (req.err && req.err.statusCode !== 404) {
      // 4xx are client errors (validation, auth, rate limit), not server
      // faults. Production keeps them at error (they're monitored); the test
      // env sets logging:logClientErrorsAsError=false to demote them to warn,
      // where every deliberate error-response assertion (expectStatus(4xx))
      // would otherwise log a redundant line.
      const isClientError = req.err.statusCode >= 400 && req.err.statusCode < 500;
      if (isClientError && config.get('logging:logClientErrorsAsError') === false) {
        logging.warn({ req: logged.req, res: logged.res, err: req.err });
      } else {
        logging.error({ req: logged.req, res: logged.res, err: req.err });
      }
    } else {
      logging.info({ req: logged.req, res: logged.res });
    }

    res.removeListener('finish', logResponse);
    res.removeListener('close', logResponse);
  }

  res.on('finish', logResponse);
  res.on('close', logResponse);
  next();
};
