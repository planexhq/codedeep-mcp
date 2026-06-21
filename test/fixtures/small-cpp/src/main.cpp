#include "greeter.h"
#include "shape.h"

#include <iostream>

namespace {

// A free helper defined and called within this file.
sample::Circle defaultShape() {
  return sample::Circle(1.0);
}

}  // namespace

int main() {
  sample::Greeter greeter("Hi");
  std::cout << greeter.greet("probe") << std::endl;

  sample::Circle circle = defaultShape();
  std::cout << circle.area() << std::endl;
  return 0;
}
