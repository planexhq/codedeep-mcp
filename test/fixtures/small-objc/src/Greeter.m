#import "Greeter.h"

@implementation Greeter

- (instancetype)initWithName:(NSString *)name {
  self = [super init];
  if (self) {
    _name = name;
  }
  return self;
}

- (NSString *)greet {
  return [self format];
}

// Not declared in the header — a private helper.
- (NSString *)format {
  return [NSString stringWithFormat:@"Hello, %@", self.name];
}

@end
