# The gate (frostyard/core ADR-0044): make verify, make check and make ci.
# npm run lint, npm test and npm run typecheck need the Pi Pocket checkout: link.mjs links it
# (PI_POCKET_CHECKOUT, default ../pi-pocket). Node is pinned in mise.toml and mise.lock.
NODE_MAJOR := $(shell node -p "process.versions.node.split('.')[0]" 2>/dev/null)

.PHONY: verify verify-template check ci

## verify-template: the template gate: agent surfaces, docs index, risk paths, corrections, vendored copies (npm test runs its tests)
verify-template:
	@if ! command -v node >/dev/null 2>&1; then echo "FAIL: make verify requires Node.js 22 or later (run: mise install)"; exit 1; fi
	@if [ "$(NODE_MAJOR)" = "" ] || [ "$(NODE_MAJOR)" -lt 22 ]; then echo "FAIL: make verify requires Node.js 22 or later (found: $$(node --version 2>/dev/null || echo missing)); run: mise install"; exit 1; fi
	node scripts/check-template.mjs

## verify: the non-mutating gate: the template gate, then lint, tests and type check
verify: verify-template
	npm run lint
	npm test
	npm run typecheck

## check: the developer gate: format (Prettier and ESLint fixes), then verify
check:
	npm run format
	$(MAKE) verify

## ci: the gate CI runs: verify, then, with BASE set, the append-only check of .memory/corrections.jsonl
ci: verify
	@if [ -n "$(BASE)" ]; then node scripts/check-corrections.mjs --base "$(BASE)"; fi
