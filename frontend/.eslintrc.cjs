module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react-hooks/recommended",
    "airbnb",
    "airbnb-typescript",
    "prettier",
  ],
  ignorePatterns: ["dist", ".eslintrc.cjs"],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: "./tsconfig.json",
    tsconfigRootDir: __dirname,
  },
  plugins: [
    "react-refresh",
    "react",
    "@typescript-eslint",
    "simple-import-sort",
    "sort-keys-fix",
  ],
  rules: {
    "react-refresh/only-export-components": [
      "warn",
      { allowConstantExport: true },
    ],
    "import/prefer-default-export": "off",
    "react/react-in-jsx-scope": "off",
    quotes: "off",
    "@typescript-eslint/quotes": "off",
    "react/function-component-definition": "off",
    "simple-import-sort/imports": "error",
    "react/require-default-props": "off",
  },
};
