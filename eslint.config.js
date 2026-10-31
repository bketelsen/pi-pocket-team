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
    {
        // The page modules run in the browser: a name that is neither declared, imported, nor a browser global is a bug
        // (a ReferenceError at runtime), so `no-undef` checks them. The globals are listed by hand: the `globals`
        // package is not a dependency here.
        files: ["*-web/**/*.js"],
        languageOptions: {
            sourceType: "module",
            globals: Object.fromEntries(
                [
                    "AbortController",
                    "CSS",
                    "Event",
                    "HTMLElement",
                    "ResizeObserver",
                    "URL",
                    "URLSearchParams",
                    "cancelAnimationFrame",
                    "clearInterval",
                    "clearTimeout",
                    "console",
                    "document",
                    "fetch",
                    "getComputedStyle",
                    "history",
                    "localStorage",
                    "location",
                    "navigator",
                    "requestAnimationFrame",
                    "setInterval",
                    "setTimeout",
                    "window",
                ].map((name) => [name, "readonly"]),
            ),
        },
        rules: {
            "no-undef": "error",
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
