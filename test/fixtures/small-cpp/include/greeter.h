#ifndef SAMPLE_GREETER_H
#define SAMPLE_GREETER_H

#include <string>

namespace sample {

// Greets people with a configurable prefix.
class Greeter {
public:
  explicit Greeter(const std::string& prefix);

  // Returns the greeting for one person.
  std::string greet(const std::string& name) const;

private:
  std::string format(const std::string& name) const;

  std::string prefix_;
};

}  // namespace sample

#endif  // SAMPLE_GREETER_H
