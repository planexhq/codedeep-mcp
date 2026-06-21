#include "greeter.h"

namespace sample {

Greeter::Greeter(const std::string& prefix) : prefix_(prefix) {}

std::string Greeter::greet(const std::string& name) const {
  // Same-file out-of-line self-call: greet() -> format().
  return format(name);
}

std::string Greeter::format(const std::string& name) const {
  return prefix_ + ", " + name + "!";
}

}  // namespace sample
