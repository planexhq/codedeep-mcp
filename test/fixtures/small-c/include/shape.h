#ifndef SHAPE_H
#define SHAPE_H

#define K_PI 3.14159

struct Circle {
  double radius;
};

double circle_area(const struct Circle *c);

#endif /* SHAPE_H */
