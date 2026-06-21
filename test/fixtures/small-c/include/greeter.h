#ifndef GREETER_H
#define GREETER_H

// A greeter carries a prefix prepended to each greeting.
struct Greeter {
  const char *prefix;
};

void greeter_init(struct Greeter *g, const char *prefix);
const char *greeter_greet(struct Greeter *g, const char *name);

#endif /* GREETER_H */
