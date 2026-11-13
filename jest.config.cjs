// Standalone version of the config `percli plugin generate` used to write (it imported ../jest.shared
// from the perses/plugins monorepo, which does not exist outside it). Plain CommonJS so Jest needs no
// ts-node.
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "jsdom",
  roots: ["<rootDir>/src"],
  transform: {
    "^.+\\.(ts|tsx|js|jsx)$": [
      "@swc/jest",
      {
        // .swcrc is for the library build and excludes test files.
        swcrc: false,
        jsc: {
          parser: { syntax: "typescript", tsx: true },
          transform: { react: { runtime: "automatic" } },
        },
      },
    ],
  },
  // @perses-dev/* 0.55 ships ES modules only; let swc turn them (and their ESM-only deps) into CommonJS.
  transformIgnorePatterns: [
    "/node_modules/(?!(@perses-dev|yaml|lodash-es|date-fns|date-fns-tz|echarts|zrender|@module-federation|nanoid|uuid)/)",
  ],
  moduleNameMapper: {
    "\\.(css|less|scss)$": "<rootDir>/src/test-utils/style-stub.cjs",
    "^use-resize-observer$": "use-resize-observer/polyfilled",
  },
  setupFilesAfterEnv: ["<rootDir>/src/setup-tests.ts"],
  testTimeout: 15000,
};
