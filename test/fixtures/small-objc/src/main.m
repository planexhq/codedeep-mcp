#import "Greeter.h"
#import "Shape.h"

// A file-scope `static` factory — internal linkage, not exported.
static Greeter *makeGreeter(void) {
  return [[Greeter alloc] initWithName:@"World"];
}

int main(int argc, const char *argv[]) {
  Greeter *g = makeGreeter();
  NSLog(@"%@", [g greet]);
  return 0;
}
