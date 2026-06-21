#include "shape.h"

namespace sample {

double Shape::describe() const {
  // Same-file out-of-line self-call: describe() -> area() (virtual dispatch).
  return area();
}

Circle::Circle(double radius) : radius_(radius) {}

double Circle::area() const {
  return kPi * radius_ * radius_;
}

}  // namespace sample
