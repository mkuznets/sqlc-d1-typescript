BUF := ./bin/buf
JAVY := ./bin/javy

GENERATOR_SOURCES := \
	src/app.ts \
	src/plugin.ts \
	src/validation.ts \
	src/diagnostics.ts \
	src/generator.ts \
	src/emission-plan.ts \
	src/embeds.ts \
	src/sqlite-types.ts \
	src/d1.ts \
	src/runtime.ts \
	src/runtime.d1.ts \
	src/gen/plugin/codegen_pb.ts \
	build.mjs \
	scripts/runtime-text-plugin.mjs

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

.PHONY: generate
generate: build/plugin.wasm examples/sqlc.dev.yaml
	cd examples && sqlc -f sqlc.dev.yaml generate

.PHONY: test-generator
test-generator: node_modules
	npx tsc -p test/tsconfig.json --noEmit
	node test/build.mjs test/generator/diagnostics.test.ts test/generator/validation.test.ts test/generator/sqlite-types.test.ts test/generator/emission-plan.test.ts test/generator/embeds.test.ts test/generator/source.test.ts test/verification-contracts.test.ts
	node --test test/dist/generator-diagnostics.test.cjs test/dist/generator-validation.test.cjs test/dist/generator-sqlite-types.test.cjs test/dist/generator-emission-plan.test.cjs test/dist/generator-embeds.test.cjs test/dist/generator-source.test.cjs test/dist/verification-contracts.test.cjs

.PHONY: test-candidate
test-candidate: node_modules
	@test -n "$(CANDIDATE_WASM)" || (echo "CANDIDATE_WASM is required" >&2; exit 2)
	@test -n "$(CANDIDATE_SHA256)" || (echo "CANDIDATE_SHA256 is required" >&2; exit 2)
	@printf '%s' "$(CANDIDATE_SHA256)" | grep -Eq '^[0-9a-f]{64}$$' || (echo "CANDIDATE_SHA256 must be exactly 64 lowercase hexadecimal characters" >&2; exit 2)
	node test/build.mjs test/generator/candidate.test.ts
	CANDIDATE_WASM="$(CANDIDATE_WASM)" CANDIDATE_SHA256="$(CANDIDATE_SHA256)" node --test test/dist/generator-candidate.test.cjs

.PHONY: test
test: build/plugin.wasm
	$(MAKE) test-generator
	$(MAKE) test-candidate CANDIDATE_WASM="$(CURDIR)/build/plugin.wasm" CANDIDATE_SHA256="$$(shasum -a 256 build/plugin.wasm | awk '{print $$1}')"
	$(MAKE) generate
	cd examples/d1-worker && bun install --frozen-lockfile
	cd examples/d1-worker && bunx tsc --noEmit
	cd examples/d1-worker && bunx tsc -p test/tsconfig.json --noEmit
	cd examples/d1-worker && bun run test -- --run

.PHONY: clean
clean:
	rm -rf build test/dist

.PHONY: distclean
distclean: clean
	rm -rf bin node_modules
