// Single source of truth for the languages whose extractors resolve call
// targets at extract time, with the symbol kinds a resolved `calls` ref may
// legally point at. Both the resolved-edge oracle (validates targets against
// the kind set) and the resolution-rate oracle (reports per-language rates)
// derive from this — adding the next extractor here updates both, so the two
// can't drift (resolution-rate reporting on a language resolved-edge never
// validates). TS/Py resolve same-file bare calls too, but their callable set
// is open by design (any non-NON_CALLABLE kind), so a closed-set check would
// false-positive — they are deliberately absent.
export const ALLOWED_TARGET_KINDS: Record<string, ReadonlySet<string>> = {
  java: new Set(['method', 'class', 'interface']),
  go: new Set(['function', 'method', 'class', 'type']),
  // struct/union→class, trait→interface, enum, type alias→type; bare calls
  // and Self/Type:: associated-fn calls resolve to function/method.
  rust: new Set(['function', 'method', 'class', 'interface', 'enum', 'type']),
};

// The language list, for skip messages and per-language iteration.
export const RESOLVING_LANGS: readonly string[] = Object.keys(ALLOWED_TARGET_KINDS);
