import logging from '@tryghost/logging';
import { defineService } from '../../../kernel/define-service';
import { createOidcClient, type OidcClient } from './client';
import { readStaffAuthConfiguration } from './config';
import { getOidcUrls, getProviderKey, type OidcUrls } from './redirect';
import { deriveTransactionKey } from './transaction';
import { setStaffAuthPolicy, type StaffAuthPolicy } from '../staff-auth-policy';

const DISCOVERY_RETRY_INTERVAL_MS = 30_000;

export type PublicStaffAuthentication =
  | { mode: 'password' }
  | { mode: 'oidc'; status: 'ready' | 'unavailable'; provider_name: string; start_url: string }
  | { mode: 'unavailable' };

export type OidcService = {
  policy: StaffAuthPolicy;
  publicDescriptor: PublicStaffAuthentication;
  client?: OidcClient;
  providerKey?: string;
  transactionKey?: Uint8Array;
  urls?: OidcUrls;
};

let publicDescriptor: PublicStaffAuthentication = { mode: 'password' };

function getPublicDescriptor(): PublicStaffAuthentication {
  return publicDescriptor;
}

export default defineService(
  'Staff OIDC',
  async (): Promise<OidcService> => {
    const config = require('../../../shared/config');
    const settingsCache = require('../../../shared/settings-cache');
    const urlUtils = require('../../../shared/url-utils').default;
    const configured = readStaffAuthConfiguration(config.get('admin:auth'));

    if (configured.mode === 'password') {
      const service = {
        policy: { mode: 'password' } as const,
        publicDescriptor: { mode: 'password' } as const,
      };
      publicDescriptor = service.publicDescriptor;
      setStaffAuthPolicy(service.policy);
      return service;
    }
    if (configured.mode === 'unavailable') {
      logging.error(`[staff-oidc] configuration unavailable: ${configured.reason}`);
      const service = {
        policy: { mode: 'unavailable' } as const,
        publicDescriptor: { mode: 'unavailable' } as const,
      };
      publicDescriptor = service.publicDescriptor;
      setStaffAuthPolicy(service.policy);
      return service;
    }

    const oidcConfig = configured.oidc;
    const urls = getOidcUrls(urlUtils);
    const providerKey = getProviderKey(oidcConfig.issuer, oidcConfig.clientId, urls.callbackUrl);
    const transactionKey = deriveTransactionKey(settingsCache.get('admin_session_secret'));
    const service: OidcService = {
      policy: { mode: 'oidc', status: 'unavailable', providerKey },
      publicDescriptor: {
        mode: 'oidc',
        status: 'unavailable',
        provider_name: oidcConfig.displayName,
        start_url: urls.startUrl,
      },
      providerKey,
      transactionKey,
      urls,
    };
    publicDescriptor = service.publicDescriptor;
    setStaffAuthPolicy(service.policy);

    async function discover(): Promise<void> {
      try {
        service.client = await createOidcClient(oidcConfig);
      } catch (error) {
        logging.error('[staff-oidc] discovery unavailable; retrying in 30 seconds');
        setTimeout(() => void discover(), DISCOVERY_RETRY_INTERVAL_MS).unref();
        return;
      }

      service.policy = { mode: 'oidc', status: 'ready', providerKey };
      service.publicDescriptor = {
        mode: 'oidc',
        status: 'ready',
        provider_name: oidcConfig.displayName,
        start_url: urls.startUrl,
      };
      publicDescriptor = service.publicDescriptor;
      setStaffAuthPolicy(service.policy);
    }

    await discover();
    return service;
  },
  { getPublicDescriptor },
);
