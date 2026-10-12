# Local environment and test reproduction

Base revision: `8ae77b30a869c5c7655d5a4610df2996fee545a7`.

This local-only branch declares Node `>=22.5.0 <25` and npm `>=10.9.8 <11`.
The project-scoped official npm CLI is kept under `.tools/npm-10.9.8/` and is
ignored by Git. It does not install a global npm, modify the system PATH, or
replace any managed runtime. Set `NODE_BIN` to a compatible Node executable on
the machine that runs the commands.

```sh
NODE_BIN=/absolute/path/to/a-compatible-node
NPM_CLI=.tools/npm-10.9.8/package/bin/npm-cli.js
NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ "$NODE_BIN" "$NPM_CLI" ci
PATH="$(dirname "$NODE_BIN"):$PATH" SP_DATA_DIR=/tmp/nss-solar-env-fix-test-data \
  "$NODE_BIN" "$NPM_CLI" test
```

The verified run used npm 10.9.8 with Node v24.19.0 and passed 70 TAP tests
with zero failures. The number of files and TAP tests must be read from each
actual command result. `npm run dev` writes to `.local-data/` by default; a
non-empty external `SP_DATA_DIR` takes precedence. `npm start` is unchanged.
