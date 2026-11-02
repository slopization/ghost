import { type FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from '@tryghost/admin-x-framework';
import { useBrowseSite } from '@tryghost/admin-x-framework/api/site';
import { getStaffAuthentication } from '@tryghost/admin-x-framework/helpers';
import {
  Button,
  Field,
  FieldLabel,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  LoadingIndicator,
} from '@tryghost/shade/components';
import { Stack } from '@tryghost/shade/primitives';
import { toast } from 'sonner';
import validator from 'validator';
import { describeUnexpectedError, useAuthClient, useSetupStatus } from './client/auth-client';
import { AuthHeader, AuthLayout, FlowMessage, SubmitButton, type SubmitState } from './auth-layout';
import { reloadAdmin } from './reload';
import { peekSigninRedirect, takeSigninRedirect } from './signin-redirect';

const OIDC_ERRORS: Record<string, string> = {
  oidc_cancelled: 'Sign in was cancelled.',
  oidc_invalid_response: 'The identity provider returned an invalid response. Please try again.',
  oidc_access_denied: 'This account does not have access to Ghost Admin.',
  oidc_unavailable: 'Single sign-on is temporarily unavailable. Please try again later.',
};

export default function Signin() {
  const authClient = useAuthClient();
  const navigate = useNavigate();
  const site = useBrowseSite({ defaultErrorHandler: false });
  const setup = useSetupStatus();
  const [searchParams] = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invalid, setInvalid] = useState<{ email?: boolean; password?: boolean }>({});
  const [flowError, setFlowError] = useState('');
  const [flowNotice, setFlowNotice] = useState('');
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [isSendingReset, setIsSendingReset] = useState(false);
  const [resetRequired, setResetRequired] = useState(false);
  const [oidcNavigationError, setOidcNavigationError] = useState('');

  if (site.isLoading || setup.isPending) {
    return (
      <AuthLayout>
        <Stack align="center">
          <LoadingIndicator size="md" />
        </Stack>
      </AuthLayout>
    );
  }

  if (site.isError || !site.data) {
    return (
      <AuthLayout>
        <Stack gap="lg">
          <AuthHeader title="Unable to load sign in." />
          <Button onClick={() => void site.refetch()}>Retry</Button>
        </Stack>
      </AuthLayout>
    );
  }

  const siteData = site.data;
  const staffAuthentication = getStaffAuthentication(siteData.site);
  if (staffAuthentication.mode !== 'password') {
    const error = searchParams.get('error');
    const errorMessage = error ? OIDC_ERRORS[error] : undefined;
    const setupRequired = setup.data?.isSetup === false;
    const ready =
      staffAuthentication.mode === 'oidc' &&
      staffAuthentication.status === 'ready' &&
      !setupRequired;
    return (
      <AuthLayout>
        <Stack gap="lg">
          <AuthHeader title={siteData.site.title} />
          {ready ? (
            <Button
              size="lg"
              onClick={() => {
                try {
                  authClient.signIn.oidc({ returnTo: peekSigninRedirect() });
                } catch {
                  setOidcNavigationError(
                    'Single sign-on is temporarily unavailable. Please try again later.',
                  );
                }
              }}
            >
              Sign in with {staffAuthentication.provider_name}
            </Button>
          ) : setupRequired ? (
            <FlowMessage error>
              Complete the initial site setup before enabling single sign-on.
            </FlowMessage>
          ) : (
            <FlowMessage error>Staff sign in is temporarily unavailable.</FlowMessage>
          )}
          {errorMessage && <FlowMessage error>{errorMessage}</FlowMessage>}
          {oidcNavigationError && <FlowMessage error>{oidcNavigationError}</FlowMessage>}
        </Stack>
      </AuthLayout>
    );
  }

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    setFlowError('');

    const emailInvalid = !email.trim() || !validator.isEmail(email);
    const passwordBlank = !password.trim();
    if (emailInvalid || passwordBlank) {
      setInvalid({ email: emailInvalid, password: passwordBlank });
      setFlowError('Please fill out the form to sign in.');
      setSubmitState('failed');
      return;
    }

    setInvalid({});
    setSubmitState('running');
    try {
      const { data, error } = await authClient.signIn.email({ email, password });
      if (data && 'twoFactorRedirect' in data) {
        navigate('/signin/verify', { state: { twoFactorReason: data.twoFactorReason } });
      } else if (data) {
        reloadAdmin(takeSigninRedirect());
      } else {
        setInvalid({ password: error.code === 'INVALID_PASSWORD' });
        setFlowError(error.message ?? '');
        setResetRequired(error.code === 'PASSWORD_RESET_REQUIRED');
        setSubmitState('failed');
      }
    } catch (error) {
      toast.error(describeUnexpectedError(error, 'There was a problem on the server.'), {
        id: 'signin',
      });
      setSubmitState('failed');
    }
  };

  const sendPasswordReset = async () => {
    setFlowError('');
    setFlowNotice('');

    if (!validator.isEmail(email)) {
      setInvalid({ email: true });
      setFlowError('We need your email address to reset your password.');
      return;
    }

    setInvalid({});
    setIsSendingReset(true);
    try {
      const { error } = await authClient.requestPasswordReset({ email });
      if (error) {
        setInvalid({ email: error.code === 'USER_NOT_FOUND' });
        setFlowError(error.message ?? '');
      } else {
        setFlowNotice('An email with password reset instructions has been sent.');
      }
    } catch (error) {
      toast.error(
        describeUnexpectedError(error, 'There was a problem with the reset, please try again.'),
        { id: 'forgot-password' },
      );
    } finally {
      setIsSendingReset(false);
    }
  };

  if (resetRequired) {
    return (
      <AuthLayout>
        <AuthHeader title="Update your password.">
          <p className="text-lg text-muted-foreground">
            For security, you need to create a new password. An email has been sent to you with
            instructions.
          </p>
        </AuthHeader>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <form noValidate onSubmit={(event) => void signIn(event)}>
        <Stack gap="lg">
          <AuthHeader title={siteData.site.title} />
          <Field>
            <FieldLabel htmlFor="identification">Email address</FieldLabel>
            <Input
              aria-invalid={invalid.email || undefined}
              autoCapitalize="off"
              autoComplete="username"
              autoCorrect="off"
              data-test-input="email"
              id="identification"
              name="identification"
              placeholder="jamie@example.com"
              type="email"
              value={email}
              onBlur={() =>
                setInvalid((current) => ({
                  ...current,
                  email: email.trim() !== '' && !validator.isEmail(email),
                }))
              }
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <InputGroup>
              <InputGroupInput
                aria-invalid={invalid.password || undefined}
                autoComplete="current-password"
                autoCorrect="off"
                data-test-input="password"
                id="password"
                name="password"
                placeholder="•••••••••••••••"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  disabled={isSendingReset}
                  onClick={() => void sendPasswordReset()}
                >
                  {isSendingReset ? <LoadingIndicator size="sm" /> : 'Forgot?'}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </Field>
          <SubmitButton label="Sign in →" state={submitState} accent />
        </Stack>
      </form>
      <FlowMessage error={Boolean(flowError)}>{flowError || flowNotice}</FlowMessage>
    </AuthLayout>
  );
}
