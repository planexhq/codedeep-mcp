# Vendored tree-sitter grammars

Grammars that are **not** available on npm in a loadable form are committed here
and copied into `grammars/` by `scripts/copy-grammars.mjs` at build time
(`grammars/` is gitignored and regenerated; this dir is tracked).

## tree-sitter-dart.wasm

- **Grammar:** [nielsenko/tree-sitter-dart](https://github.com/nielsenko/tree-sitter-dart)
  (v0.2.0), pinned commit `b57d734c84f510bbd524097902cab671e4dbfca9`.
- **Why this fork (not npm `tree-sitter-dart` / `@repomix/tree-sitter-wasms`):**
  the npm/Benjamin-Sobel grammar emits flat selector chains with **no
  `call_expression` node** and detached function bodies — a poor fit for the
  shared `resolveCalls` engine. The nielsenko fork has discrete
  `call_expression{function:,arguments:}` / `member_expression{object:,property:}`
  and attached `body:function_body`, so Dart reuses the engine with zero changes.
- **sha1:** `28c96124e73d0d2b41c89f9c5cbf0460b7ba895c`
- **Rebuild:**
  ```sh
  git clone https://github.com/nielsenko/tree-sitter-dart
  cd tree-sitter-dart
  git checkout b57d734c84f510bbd524097902cab671e4dbfca9
  npx tree-sitter-cli@0.26.8 build --wasm   # toolchain auto via Docker/wasi-sdk
  # → tree-sitter-dart.wasm (ABI 15; loads in web-tree-sitter 0.26.8)
  ```
