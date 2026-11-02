const config = require('./config');
const SentryKnexTracingIntegration = require('./sentry-knex-tracing-integration');
const sentryConfig = config.get('sentry');
let _errors;
const OIDC_PATH = /\/ghost\/auth\/oidc\/(?:start|callback)\/?(?:\?|$)/i;

function sanitizeOidcEvent(event) {
  const requestUrl = event.request?.url || '';
  if (!OIDC_PATH.test(requestUrl)) {
    return event;
  }

  if (event.request) {
    event.request.url = requestUrl.split('?')[0];
    delete event.request.query_string;
    delete event.request.cookies;
    if (event.request.headers) {
      delete event.request.headers.cookie;
      delete event.request.headers.Cookie;
      delete event.request.headers['x-original-uri'];
    }
  }
  event.extra = {};
  event.contexts = {};
  event.breadcrumbs = [];
  if (event.exception?.values) {
    event.exception.values = event.exception.values.map((value) => ({
      type: value.type,
      value: 'Staff OIDC request failed',
    }));
  }
  return event;
}

/**
 * @param {import('@sentry/node').Event} event
 * @param {import('@sentry/node').EventHint} hint
 * @returns {import('@sentry/node').Event | null}
 */
const beforeSend = function (event, hint) {
  try {
    event = sanitizeOidcEvent(event);
    const errors = _errors || (_errors = require('@tryghost/errors'));
    const exception = hint.originalException;
    const code = exception?.code ?? null;
    const context = exception?.context ?? null;
    const errorType = exception?.errorType ?? null;
    const id = exception?.id ?? null;
    const statusCode = exception?.statusCode ?? null;
    event.tags = event.tags || {};

    if (errors.utils.isGhostError(exception)) {
      // Unexpected errors have a generic error message, set it back to context if there is one
      if (code === 'UNEXPECTED_ERROR' && context !== null) {
        if (event.exception.values?.length > 0) {
          event.exception.values[0].type = context;
        }
      }

      // This is a mysql2 error — add some additional context
      if (exception.sql) {
        const sql = exception.sql;
        const errno = exception.errno ?? null;
        const sqlErrorCode = exception.sqlErrorCode ?? null;
        const sqlMessage = exception.sqlMessage ?? null;
        const sqlState = exception.sqlState ?? null;

        if (event.exception.values?.length > 0) {
          event.exception.values[0].type = `SQL Error ${errno}: ${sqlErrorCode}`;
          event.exception.values[0].value = sqlMessage;
          event.contexts = event.contexts || {};
          event.contexts.mysql = {
            errno: errno,
            code: sqlErrorCode,
            sql: sql,
            message: sqlMessage,
            state: sqlState,
          };
        }
      }

      // This is a Ghost Error, copy all our extra data to tags
      event.tags.type = errorType;
      event.tags.code = code;
      event.tags.id = id;
      event.tags.status_code = statusCode;

      // Only handle 500 errors for now
      // This is because the only other 5XX error should be 503, which are deliberate maintenance/boot errors
      if (statusCode === 500) {
        return event;
      } else {
        return null;
      }
    }
    return event;
  } catch (error) {
    // OIDC events can contain authorization codes or tokens in provider errors.
    return OIDC_PATH.test(event.request?.url || '') ? null : event;
  }
};

const ALLOWED_HTTP_TRANSACTIONS = [
  '/ghost/api', // any Ghost API call
  '/members/api', // any Members API call
  '/:slug', // any frontend post/page
  '/author', // any frontend author page
  '/tag', // any frontend tag page
].map((path) => {
  // Sentry names HTTP transactions like: "<HTTP_METHOD> <PATH>" i.e. "GET /ghost/api/content/settings"
  // Match any of the paths above with any HTTP method, and also the homepage "GET /"
  return new RegExp(`^(GET|POST|PUT|DELETE)\\s(?<path>${path}\\/.+|\\/$)`);
});

/**
 * @param {import('@sentry/node').Event} event
 * @returns {import('@sentry/node').Event | null}
 */
const beforeSendTransaction = function (event) {
  // Drop transactions that are not in the allowed list
  for (const transaction of ALLOWED_HTTP_TRANSACTIONS) {
    const match = event.transaction.match(transaction);

    if (match?.groups?.path) {
      return event;
    }
  }

  return null;
};

if (sentryConfig && !sentryConfig.disabled) {
  const Sentry = require('@sentry/node');
  const version = require('@tryghost/version').full;

  let environment = config.get('PRO_ENV');
  if (!environment) {
    environment = config.get('env');
  }

  /** @type {import('@sentry/node').NodeOptions} */
  const sentryInitConfig = {
    dsn: sentryConfig.dsn,
    release: 'ghost@' + version,
    environment: environment,
    maxValueLength: 1000,
    integrations: [Sentry.extraErrorDataIntegration()],
    beforeSend,
    beforeSendTransaction,
  };

  // Enable tracing if sentry.tracing.enabled is true
  if (sentryConfig.tracing?.enabled === true) {
    sentryInitConfig.integrations.push(new Sentry.Integrations.Http({ tracing: true }));
    sentryInitConfig.tracesSampleRate = parseFloat(sentryConfig.tracing.sampleRate) || 0.0;
  }
  Sentry.init(sentryInitConfig);

  module.exports = {
    requestHandler: Sentry.Handlers.requestHandler(),
    errorHandler: Sentry.Handlers.errorHandler(),
    tracingHandler: Sentry.Handlers.tracingHandler(),
    captureException: Sentry.captureException,
    captureMessage: Sentry.captureMessage,
    beforeSend: beforeSend,
    beforeSendTransaction: beforeSendTransaction,
    initQueryTracing: (knex) => {
      if (sentryConfig.tracing?.enabled === true) {
        const integration = new SentryKnexTracingIntegration(knex);

        Sentry.addIntegration(integration);
      }
    },
  };
} else {
  const expressNoop = function (req, res, next) {
    next();
  };

  const noop = () => {};

  module.exports = {
    requestHandler: expressNoop,
    errorHandler: expressNoop,
    tracingHandler: expressNoop,
    captureException: noop,
    captureMessage: noop,
    initQueryTracing: noop,
  };
}
