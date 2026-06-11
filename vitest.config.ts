import { configDefaults, defineConfig } from 'vitest/config';

// The dogfooding harness (scripts/dogfood) clones real repos into
// dogfood-cache/ and writes per-run scratch indexes under dogfood-runs/.
// Those checkouts contain their own *.test.ts / *.spec.ts files, which
// vitest's default glob would otherwise pick up and run. Vitest does not
// honor .gitignore for test discovery, so exclude them explicitly here
// (preserving the built-in excludes for node_modules/dist/etc.).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dogfood-cache/**', 'dogfood-runs/**'],
  },
});
