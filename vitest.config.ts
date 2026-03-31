import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // react-native contains Flow syntax that Vite cannot parse.
      // Redirect to a stub so tests can vi.mock() specific APIs without Vite failing to transform the real package.
      'react-native': new URL('./tests/__mocks__/react-native.ts', import.meta.url).pathname
    }
  }
});
