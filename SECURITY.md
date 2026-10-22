# Security policy

This repository is a modified fork of DeepSeek Harness. Report a vulnerability that
exists only in this fork here; report one that exists upstream to the upstream project.

## Reporting

Please do not open a public issue for a vulnerability. Open a
[private security advisory](https://github.com/alextomdog/harness-desktop/security/advisories/new)
instead, and describe the impact and the steps that reproduce it.

## Scope

The desktop application runs an agent that may read files, run shell commands, and open
pages. Anything that lets a page, a document, or a plugin reach past what the reader
granted is in scope. The bundled runtimes and third-party dependencies are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).