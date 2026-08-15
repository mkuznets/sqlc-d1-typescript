BUF := ./bin/buf
JAVY := ./bin/javy

# The candidate under test. Every target that needs the plugin defaults to the one
# `make build` produces; pass CANDIDATE=/path/to/plugin.wasm to test a different one.
CANDIDATE ?= $(CURDIR)/build/plugin.wasm

GENERATOR_SOURCES := $(wildcard src/*.ts) src/gen/plugin/codegen_pb.ts build.ts
# Tests that need no plugin binary. The candidate suites are excluded because they
# take one; `make test-candidate` runs those.
UNIT_TESTS := $(filter-out %candidate.test.ts,$(wildcard test/*.test.ts test/generator/*.test.ts))

.PHONY: build
build: build/plugin.wasm

$(BUF):
	bash scripts/install-buf.sh
$(JAVY):
	bash scripts/install-javy.sh
node_modules: package.json package-lock.json
	npm install
	touch node_modules

src/runtime.ts: src/runtime.d1.ts scripts/extract-runtime.ts
	node scripts/extract-runtime.ts
src/gen/plugin/codegen_pb.ts: buf.gen.yaml | $(BUF)
	$(BUF) generate --template buf.gen.yaml buf.build/sqlc/sqlc --path plugin/
build/out.js: node_modules src/runtime.ts $(GENERATOR_SOURCES)
	npx tsc --noEmit
	npx tsc -p scripts/tsconfig.json --noEmit
	node build.ts
build/plugin.wasm: build/out.js | $(JAVY)
	$(JAVY) build build/out.js -o build/plugin.wasm -C source=omitted

.PHONY: fmt
fmt: node_modules
	npx prettier --write .

.PHONY: fmt-check
fmt-check: node_modules
	npx prettier --check .

.PHONY: test-unit
test-unit: node_modules src/runtime.ts
	npx tsc -p test/tsconfig.json --noEmit
	npx tsc -p scripts/tsconfig.json --noEmit
	node --test $(UNIT_TESTS)

.PHONY: test-candidate
test-candidate: node_modules
	CANDIDATE_WASM="$(CANDIDATE)" node --test test/generator/candidate.test.ts test/types/candidate.test.ts

.PHONY: test-miniflare
test-miniflare:
	cd test/miniflare && bun install --frozen-lockfile
	cd test/miniflare && bun run typecheck && bun run typecheck:test && bun run test:run

.PHONY: test-example
test-example:
	cd examples/d1-worker && bun install --frozen-lockfile
	cd examples/d1-worker && bun run typecheck && bun run typecheck:test && bun run test:run

# Regenerates every fixture in a throwaway copy and diffs it against what is checked
# in. Needs sqlc on PATH; never touches the working tree.
.PHONY: test-drift
test-drift:
	node scripts/check-generated-drift.ts --candidate "$(CANDIDATE)"

.PHONY: test-sqlc-compatibility
test-sqlc-compatibility:
	@test -n "$(SQLC_VERSION)" || (echo "SQLC_VERSION is required" >&2; exit 2)
	@test -n "$(SQLC_BIN)" || (echo "SQLC_BIN is required" >&2; exit 2)
	node scripts/verify-sqlc-compatibility.ts --candidate "$(CANDIDATE)" --sqlc-version "$(SQLC_VERSION)" --sqlc "$(SQLC_BIN)"

# Everything that needs no credentials, against a freshly built plugin.
.PHONY: verify-local
verify-local: build
	$(MAKE) test-unit
	$(MAKE) test-candidate
	$(MAKE) test-drift
	$(MAKE) test-miniflare
	$(MAKE) test-example

.PHONY: test
test: verify-local

.PHONY: clean
clean:
	rm -rf build src/runtime.ts
.PHONY: distclean
distclean: clean
	rm -rf bin node_modules
