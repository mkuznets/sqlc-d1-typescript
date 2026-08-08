BUF := ./bin/buf
JAVY := ./bin/javy

build: build/plugin.wasm

$(BUF):
	bash scripts/install-buf.sh

$(JAVY):
	bash scripts/install-javy.sh

node_modules: package.json package-lock.json
	npm install
	touch node_modules

build/out.js: node_modules src/app.ts $(wildcard src/drivers/*.ts) src/gen/plugin/codegen_pb.ts build.mjs
	npx tsc --noEmit
	node build.mjs

src/gen/plugin/codegen_pb.ts: buf.gen.yaml | $(BUF)
	$(BUF) generate --template buf.gen.yaml buf.build/sqlc/sqlc --path plugin/

build/plugin.wasm: build/out.js | $(JAVY)
	$(JAVY) build build/out.js -o build/plugin.wasm -C source=omitted

.PHONY: generate
generate: build/plugin.wasm examples/sqlc.dev.yaml
	cd examples && sqlc -f sqlc.dev.yaml generate

.PHONY: test
test: generate
	npx tsc --noEmit
	cd examples/d1-worker && bun install --frozen-lockfile
	cd examples/d1-worker && bunx tsc --noEmit && bun run test -- --run

.PHONY: clean
clean:
	rm -rf build

.PHONY: distclean
distclean: clean
	rm -rf bin node_modules
