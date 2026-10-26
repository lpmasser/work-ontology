# Project context

InfoHub is the shared project context for maintainers. Locate it through `~/.config/infohub/config.json` (on Windows, under the user profile), then run `infohub brief ontology-doc` and read the applicable project standards and implementation notes. InfoHub content is supplied by each user and is not part of this repository. If it is unavailable, ask the maintainer for the relevant context; never assume a private repository address.

Keep ontology rules in `core/`; CLI, desktop and server consumers reuse them. Preserve platform behavior on macOS, Windows and Linux. Run the existing `npm test` suite before submitting code. Tests protect observable contracts and concrete failures, not implementation structure.
