#import "Shape.h"

@implementation Circle {
  double _radius;
}

- (instancetype)initWithRadius:(double)radius {
  self = [super init];
  if (self) {
    _radius = radius;
  }
  return self;
}

- (double)area {
  return 3.14159 * _radius * _radius;
}

@end
