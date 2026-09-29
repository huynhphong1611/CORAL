/** UI strings (English, clarify Q1). User data (intent, names, app text) is shown as is. */
export const en = {
  brand: 'coral',
  tagline: 'Tests that grow back',
  nav: { projects: 'Projects', devices: 'Devices', runs: 'Runs' },
  session: { signOut: 'Sign out', loading: 'Loading…' },
  roles: { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' },
  login: {
    title: 'Sign in',
    subtitle: 'Operate devices and record tests from the browser.',
    email: 'Email',
    password: 'Password',
    submit: 'Sign in',
    submitting: 'Signing in…',
    invalid: 'Invalid email or password',
    tooMany: 'Too many attempts. Try again in a few minutes.',
    failed: 'Could not sign in',
  },
  common: {
    loading: 'Loading…',
    empty: 'Nothing here yet',
    error: 'Something went wrong',
    comingSoon: 'This screen arrives with the next user story.',
  },
} as const
