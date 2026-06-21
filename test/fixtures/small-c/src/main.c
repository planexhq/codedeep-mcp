#include "greeter.h"
#include "shape.h"

#include <stdio.h>

// File-scope static helper (internal linkage).
static struct Circle default_shape(void) {
  struct Circle c;
  c.radius = 1.0;
  return c;
}

int main(void) {
  // Within-file resolved edge: main() -> default_shape().
  struct Circle c = default_shape();
  printf("%f\n", circle_area(&c));
  return 0;
}
