import { z } from 'zod';

const oidcSchema = z.object({
  issuer: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      );
    }),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  displayName: z.string().trim().min(1).default('SSO'),
  tokenEndpointAuthMethod: z
    .enum(['client_secret_basic', 'client_secret_post'])
    .default('client_secret_basic'),
});

export type OidcConfiguration = z.infer<typeof oidcSchema>;

export type StaffAuthConfiguration =
  | { mode: 'password' }
  | { mode: 'oidc'; oidc: OidcConfiguration }
  | { mode: 'unavailable'; reason: 'invalid_mode' | 'invalid_oidc_configuration' };

export function readStaffAuthConfiguration(value: unknown): StaffAuthConfiguration {
  const mode = value && typeof value === 'object' && 'mode' in value ? value.mode : 'password';

  if (mode === 'password') {
    return { mode: 'password' };
  }
  if (mode !== 'oidc') {
    return { mode: 'unavailable', reason: 'invalid_mode' };
  }

  const oidc = value && typeof value === 'object' && 'oidc' in value ? value.oidc : undefined;
  const result = oidcSchema.safeParse(oidc);
  if (!result.success) {
    return { mode: 'unavailable', reason: 'invalid_oidc_configuration' };
  }

  return { mode: 'oidc', oidc: result.data };
}
