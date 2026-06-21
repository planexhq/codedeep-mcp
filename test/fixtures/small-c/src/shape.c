#include "shape.h"

double circle_area(const struct Circle *c) {
  return K_PI * c->radius * c->radius;
}
