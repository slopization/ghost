import type { OidcConfiguration } from './config';
import { IncorrectUsageError } from '@tryghost/errors';

type OpenIdClient = typeof import('openid-client');

export type OidcClient = {
  library: OpenIdClient;
  configuration: import('openid-client').Configuration;
};

export async function createOidcClient(configuration: OidcConfiguration): Promise<OidcClient> {
  const library = await import('openid-client');
  const clientAuthentication =
    configuration.tokenEndpointAuthMethod === 'client_secret_post'
      ? library.ClientSecretPost(configuration.clientSecret)
      : library.ClientSecretBasic(configuration.clientSecret);
  const client = await library.discovery(
    new URL(configuration.issuer),
    configuration.clientId,
    {
      client_secret: configuration.clientSecret,
      token_endpoint_auth_method: configuration.tokenEndpointAuthMethod,
    },
    clientAuthentication,
    { timeout: 10, execute: [library.enableNonRepudiationChecks] },
  );

  const supported = client.serverMetadata().token_endpoint_auth_methods_supported;
  if (supported && !supported.includes(configuration.tokenEndpointAuthMethod)) {
    throw new IncorrectUsageError({
      code: 'OIDC_TOKEN_ENDPOINT_AUTH_METHOD_UNSUPPORTED',
      message: 'The OIDC provider does not support the configured client authentication method.',
    });
  }

  return { library, configuration: client };
}

export async function buildLoginUrl(
  client: OidcClient,
  callbackUrl: string,
  transaction: { state: string; nonce: string; codeVerifier: string },
): Promise<URL> {
  const codeChallenge = await client.library.calculatePKCECodeChallenge(transaction.codeVerifier);
  return client.library.buildAuthorizationUrl(client.configuration, {
    redirect_uri: callbackUrl,
    response_type: 'code',
    response_mode: 'query',
    scope: 'openid email',
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
}

export async function validateAuthorizationResponse(
  client: OidcClient,
  callbackUrl: string,
  query: string,
  transaction: { state: string; nonce: string; codeVerifier: string },
) {
  const currentUrl = new URL(callbackUrl);
  currentUrl.search = query;
  return client.library.authorizationCodeGrant(client.configuration, currentUrl, {
    expectedState: transaction.state,
    expectedNonce: transaction.nonce,
    pkceCodeVerifier: transaction.codeVerifier,
    idTokenExpected: true,
  });
}
