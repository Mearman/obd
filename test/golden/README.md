# Golden command-line records

Each `<scenario>.golden.json` holds the exact standard output, standard error, exit status, written files and broker traffic of one command line in `scenarios.json`, recorded from the Python tool at commit `89225bb4c5830f12fb09dcd547fc6b4a32638b50`, the last commit before the Python was deleted. They are now the contract for the command line: `pnpm test:parity` runs every scenario through the TypeScript command line on scripted adapters and compares, and `test/parity/normalise.ts` lists the only allowed differences.

The recorder is gone with the Python, so the files are edited by hand when the command line's behaviour is changed on purpose, in the same change as the code, and `scenarios.json` and the files must stay one to one.

The `share` command exists only in the TypeScript tool, so no scenario runs it and it has no record here; its tests are in `test/share-cli.test.ts`. It appears in `usage-unknown-command` because that record lists every command.
