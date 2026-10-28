import stylistic from "@stylistic/eslint-plugin";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

// Layout only: Prettier formats, and these rules give the code room to breathe.
export default [
    {
        // The vendored xterm.js is not this project code: neither linter reads it (nor .prettierignore).
        ignores: ["node_modules/**", "_pocket/**", "terminal-web/vendor/**"],
    },
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tseslint.parser,
        },
    },
    prettier,
    {
        files: ["**/*.{js,mjs,cjs,ts}"],
        plugins: {
            "@stylistic": stylistic,
        },
        rules: {
            curly: ["error", "all"],
            "@stylistic/padding-line-between-statements": [
                "error",
                { blankLine: "always", prev: "directive", next: "*" },
                { blankLine: "any", prev: "directive", next: "directive" },
                { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
                {
                    blankLine: "any",
                    prev: ["const", "let", "var"],
                    next: ["const", "let", "var"],
                },
                {
                    blankLine: "always",
                    prev: "*",
                    next: ["block-like", "return", "throw"],
                },
                { blankLine: "always", prev: "block-like", next: "*" },
            ],
        },
    },
];
