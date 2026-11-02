const debug = require('@tryghost/debug')('web:backend');
const express = require('../../../shared/express');
const { BASE_API_PATH } = require('../../../shared/url-utils');

/**
 *
 * @returns {import('express').Application}
 */
module.exports = () => {
  debug('BackendApp setup start');
  // BACKEND
  // Wrap the admin and API apps into a single express app for use with vhost
  const backendApp = express('backend');

  backendApp.lazyUse(BASE_API_PATH, require('../api'));
  backendApp.lazyUse('/ghost/.well-known', require('../well-known'));
  backendApp.lazyUse('/ghost/auth/oidc', () => require('../admin/oidc/router').createOidcRouter());

  backendApp.use(
    '/ghost',
    require('../../auth/session').createSessionFromToken(),
    require('../admin')(),
  );

  return backendApp;
};
