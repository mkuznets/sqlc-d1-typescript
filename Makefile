BUF := ./bin/buf
JAVY := ./bin/javy

GENERATOR_SOURCES := \
	src/app.ts src/plugin.ts src/validation.ts src/diagnostics.ts src/generator.ts \
	src/emission-plan.ts src/embeds.ts src/sqlite-types.ts src/d1.ts src/runtime.ts \
	src/runtime.d1.ts src/gen/plugin/codegen_pb.ts build.mjs scripts/runtime-text-plugin.mjs \
	verification/compatibility.json

ROOT_TESTS := \
	test/generator/diagnostics.test.ts test/generator/validation.test.ts \
	test/generator/sqlite-types.test.ts test/generator/emission-plan.test.ts \
	test/generator/embeds.test.ts test/generator/source.test.ts \
	test/verification-contracts.test.ts test/candidate-scripts.test.ts \
	test/compatibility-scripts.test.ts test/release-scripts.test.ts
ROOT_SCRIPTS := \
	scripts/compatibility-config.mjs scripts/check-compatibility.mjs \
	scripts/verify-sqlc-compatibility.mjs scripts/check-upstream-compatibility.mjs \
	scripts/write-compatibility-evidence.mjs scripts/release-contract.mjs \
	scripts/github-run-artifacts.mjs
ROOT_DIST := \
	test/dist/generator-diagnostics.test.cjs test/dist/generator-validation.test.cjs \
	test/dist/generator-sqlite-types.test.cjs test/dist/generator-emission-plan.test.cjs \
	test/dist/generator-embeds.test.cjs test/dist/generator-source.test.cjs \
	test/dist/verification-contracts.test.cjs test/dist/candidate-scripts.test.cjs \
	test/dist/compatibility-scripts.test.cjs test/dist/release-scripts.test.cjs
DOCUMENTATION_TESTS := test/documentation.test.ts
DOCUMENTATION_DIST := test/dist/documentation.test.cjs

build: build/plugin.wasm

$(BUF):
	bash scripts/install-buf.sh
$(JAVY):
	bash scripts/install-javy.sh
node_modules: package.json package-lock.json
	npm install
	touch node_modules
build/out.js: node_modules $(GENERATOR_SOURCES)
	npx tsc --noEmit
	node build.mjs
src/gen/plugin/codegen_pb.ts: buf.gen.yaml | $(BUF)
	$(BUF) generate --template buf.gen.yaml buf.build/sqlc/sqlc --path plugin/
build/plugin.wasm: build/out.js | $(JAVY)
	$(JAVY) build build/out.js -o build/plugin.wasm -C source=omitted

.PHONY: validate-candidate
validate-candidate:
	@test -n "$(CANDIDATE_WASM)" || (echo "CANDIDATE_WASM is required" >&2; exit 2)
	@test -n "$(CANDIDATE_SHA256)" || (echo "CANDIDATE_SHA256 is required" >&2; exit 2)
	@printf '%s' "$(CANDIDATE_SHA256)" | grep -Eq '^[0-9a-f]{64}$$' || (echo "CANDIDATE_SHA256 must be exactly 64 lowercase hexadecimal characters" >&2; exit 2)
	@node -e 'import("./scripts/candidate-utils.mjs").then(m=>m.validateCandidate(process.argv[1],process.argv[2])).catch(e=>{console.error(e.message);process.exit(e.exitCode||1)})' "$(CANDIDATE_WASM)" "$(CANDIDATE_SHA256)"

define validate_candidate
	@$(MAKE) --no-print-directory validate-candidate CANDIDATE_WASM="$(CANDIDATE_WASM)" CANDIDATE_SHA256="$(CANDIDATE_SHA256)"
endef

.PHONY: test-generator
test-generator: node_modules $(ROOT_SCRIPTS) verification/compatibility.json verification/compatibility.schema.json
	npx tsc -p test/tsconfig.json --noEmit
	node test/build.mjs $(ROOT_TESTS)
	node --test $(ROOT_DIST)

.PHONY: test-release-contract
test-release-contract: node_modules $(ROOT_SCRIPTS) verification/release-manifest.schema.json
	npx tsc -p test/tsconfig.json --noEmit
	node test/build.mjs test/release-scripts.test.ts test/verification-contracts.test.ts
	node --test test/dist/release-scripts.test.cjs test/dist/verification-contracts.test.cjs

.PHONY: test-compatibility-config
test-compatibility-config: node_modules
	npx tsc -p test/tsconfig.json --noEmit
	node test/build.mjs test/compatibility-scripts.test.ts
	node --test test/dist/compatibility-scripts.test.cjs
	node scripts/check-compatibility.mjs

.PHONY: test-candidate
test-candidate: node_modules
	$(validate_candidate)
	node test/build.mjs test/generator/candidate.test.ts
	CANDIDATE_WASM="$(CANDIDATE_WASM)" CANDIDATE_SHA256="$(CANDIDATE_SHA256)" node --test test/dist/generator-candidate.test.cjs

.PHONY: test-types
test-types: node_modules
	$(validate_candidate)
	node test/build.mjs test/types/candidate.test.ts
	CANDIDATE_WASM="$(CANDIDATE_WASM)" CANDIDATE_SHA256="$(CANDIDATE_SHA256)" node --test test/dist/types-candidate.test.cjs

.PHONY: test-documentation
test-documentation: node_modules
	$(validate_candidate)
	@test -n "$(SQLC_BIN)" || (echo "SQLC_BIN is required" >&2; exit 2)
	npx tsc -p test/tsconfig.json --noEmit
	node test/build.mjs $(DOCUMENTATION_TESTS)
	CANDIDATE_WASM="$(CANDIDATE_WASM)" CANDIDATE_SHA256="$(CANDIDATE_SHA256)" SQLC_BIN="$(SQLC_BIN)" node --test $(DOCUMENTATION_DIST)

.PHONY: test-miniflare
test-miniflare:
	$(validate_candidate)
	cd test/miniflare && bun install --frozen-lockfile
	cd test/miniflare && bun run typecheck && bun run typecheck:test && bun run test:run

.PHONY: test-example
test-example:
	$(validate_candidate)
	cd examples/d1-worker && bun install --frozen-lockfile
	cd examples/d1-worker && bun run typecheck && bun run typecheck:test && bun run test:run

.PHONY: test-generated-drift test-generated-drift-worktree
test-generated-drift:
	$(validate_candidate)
	node scripts/check-generated-drift.mjs --candidate "$(CANDIDATE_WASM)" --sha256 "$(CANDIDATE_SHA256)" --mode mirror

test-generated-drift-worktree:
	$(validate_candidate)
	node scripts/check-generated-drift.mjs --candidate "$(CANDIDATE_WASM)" --sha256 "$(CANDIDATE_SHA256)" --mode worktree

.PHONY: test-sqlc-compatibility
test-sqlc-compatibility:
	$(validate_candidate)
	@test -n "$(SQLC_VERSION)" || (echo "SQLC_VERSION is required" >&2; exit 2)
	@test -n "$(SQLC_BIN)" || (echo "SQLC_BIN is required" >&2; exit 2)
	node scripts/verify-sqlc-compatibility.mjs --candidate "$(CANDIDATE_WASM)" --sha256 "$(CANDIDATE_SHA256)" --sqlc-version "$(SQLC_VERSION)" --sqlc "$(SQLC_BIN)"

.PHONY: check-upstream-compatibility
check-upstream-compatibility: node_modules
	node scripts/check-upstream-compatibility.mjs

.PHONY: verify-candidate
verify-candidate:
	# Mirror drift validates the supplied candidate without mutating the developer worktree.
	$(MAKE) test-generated-drift CANDIDATE_WASM="$(CANDIDATE_WASM)" CANDIDATE_SHA256="$(CANDIDATE_SHA256)"
	$(MAKE) test-generator
	$(MAKE) test-compatibility-config
	$(MAKE) test-candidate CANDIDATE_WASM="$(CANDIDATE_WASM)" CANDIDATE_SHA256="$(CANDIDATE_SHA256)"
	$(MAKE) test-types CANDIDATE_WASM="$(CANDIDATE_WASM)" CANDIDATE_SHA256="$(CANDIDATE_SHA256)"
	$(MAKE) test-miniflare CANDIDATE_WASM="$(CANDIDATE_WASM)" CANDIDATE_SHA256="$(CANDIDATE_SHA256)"
	$(MAKE) test-example CANDIDATE_WASM="$(CANDIDATE_WASM)" CANDIDATE_SHA256="$(CANDIDATE_SHA256)"

.PHONY: verify-local
verify-local:
	rm -f build/out.js build/plugin.wasm
	$(MAKE) build
	$(MAKE) verify-candidate CANDIDATE_WASM="$(CURDIR)/build/plugin.wasm" CANDIDATE_SHA256="$$(shasum -a 256 build/plugin.wasm | awk '{print $$1}')"
	$(MAKE) test-documentation CANDIDATE_WASM="$(CURDIR)/build/plugin.wasm" CANDIDATE_SHA256="$$(shasum -a 256 build/plugin.wasm | awk '{print $$1}')" SQLC_BIN="$$(command -v sqlc)"

.PHONY: test
test: verify-local

.PHONY: clean
clean:
	rm -rf build test/dist
.PHONY: distclean
distclean: clean
	rm -rf bin node_modules
