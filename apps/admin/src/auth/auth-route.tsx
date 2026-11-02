import { createContext, lazy, Suspense, useContext, useEffect } from 'react';
import { Navigate, Outlet, useLocation } from '@tryghost/admin-x-framework';
import { isAuthPath } from '@tryghost/admin-x-framework/helpers';
import { getStaffAuthentication } from '@tryghost/admin-x-framework/helpers';
import { useBrowseSite } from '@tryghost/admin-x-framework/api/site';
import { toast } from 'sonner';
import { useSetupStatus } from './client/auth-client';
import { rememberSigninRedirect } from './signin-redirect';

const screens = {
  signin: lazy(() => import('./signin')),
  signinVerify: lazy(() => import('./signin-verify')),
  signout: lazy(() => import('./signout')),
  signup: lazy(() => import('./signup')),
  reset: lazy(() => import('./reset')),
  setup: lazy(() => import('./setup')),
};

export type AuthScreen = keyof typeof screens;

// Set by the signed-out shell; auth routes rendered anywhere else are being
// visited by someone who is signed in.
const SignedOutContext = createContext(false);

const SIGNED_IN_WARNINGS: Partial<Record<AuthScreen, string>> = {
  reset: 'You can’t reset your password while you’re signed in.',
  signup: 'You need to sign out to register as a new user.',
};

function SignedInRedirect({ screen }: { screen: AuthScreen }) {
  const warning = SIGNED_IN_WARNINGS[screen];

  useEffect(() => {
    if (warning) {
      toast.warning(warning, { id: 'auth-signed-in' });
    }
  }, [warning]);

  return <Navigate to="/" replace />;
}

export function AuthRoute({ screen }: { screen: AuthScreen }) {
  const signedOut = useContext(SignedOutContext);
  const Screen = screens[screen];

  if (!signedOut && screen !== 'signout') {
    return <SignedInRedirect screen={screen} />;
  }
  return (
    <Suspense fallback={null}>
      <Screen />
    </Suspense>
  );
}

/**
 * The whole app for a signed-out visitor: auth routes render, anything else
 * is remembered for after sign in and sends the visitor to sign in. A site
 * that isn't set up yet sends every auth screen but sign out to setup.
 */
export function SignedOutApp() {
  const { pathname, search } = useLocation();
  const setup = useSetupStatus();
  const site = useBrowseSite({ defaultErrorHandler: false });
  const route = pathname.replace(/\/$/, '') || '/';

  if (!isAuthPath(pathname)) {
    rememberSigninRedirect(pathname + search);
    return <Navigate to="/signin" replace />;
  }
  if (setup.isPending || site.isLoading) {
    return null;
  }
  if (site.isError && route !== '/signin' && route !== '/signout') {
    return <Navigate to="/signin" replace />;
  }
  const authentication = site.data ? getStaffAuthentication(site.data.site) : undefined;
  const passwordMode = authentication?.mode === 'password';
  if (
    authentication &&
    !passwordMode &&
    ['/reset', '/signin/verify', '/setup'].some(
      (path) => route === path || route.startsWith(`${path}/`),
    )
  ) {
    return <Navigate to="/signin" replace />;
  }
  if (
    setup.data &&
    !setup.data.isSetup &&
    passwordMode &&
    route !== '/setup' &&
    route !== '/signout'
  ) {
    return <Navigate to="/setup" replace />;
  }
  if (
    setup.data &&
    !setup.data.isSetup &&
    !passwordMode &&
    route !== '/signin' &&
    route !== '/signout'
  ) {
    return <Navigate to="/signin" replace />;
  }
  return (
    <SignedOutContext.Provider value={true}>
      <Outlet />
    </SignedOutContext.Provider>
  );
}
