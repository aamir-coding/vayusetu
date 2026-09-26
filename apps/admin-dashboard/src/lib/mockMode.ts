/**
 * MSW mock mode. On by default in `pnpm dev` so frontend work never waits on
 * a backend; set VITE_USE_MOCKS=false to hit real services through the Vite
 * proxy (packages/config/api-routes.json). Never on in a production build.
 *
 * Before this switch existed MSW always started in dev and its `*\/api/v1/*`
 * handlers matched every origin, so pointing the app at a real service did
 * nothing.
 */
export const useMocks = import.meta.env.DEV && import.meta.env.VITE_USE_MOCKS !== 'false';
