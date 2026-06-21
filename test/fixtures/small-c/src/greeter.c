#include "greeter.h"

// File-scope static: internal linkage — C's privacy mechanism. The index must
// mark this exported=false (not part of the public API).
static const char *format(struct Greeter *g, const char *name) {
  (void)g;
  return name;
}

void greeter_init(struct Greeter *g, const char *prefix) {
  g->prefix = prefix;
}

const char *greeter_greet(struct Greeter *g, const char *name) {
  // Same-file bare call: greeter_greet() -> format().
  return format(g, name);
}
