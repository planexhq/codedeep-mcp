#ifndef SAMPLE_SHAPE_H
#define SAMPLE_SHAPE_H

namespace sample {

// Pi is good enough for the demo.
constexpr double kPi = 3.14159;

// Shape is anything with a measurable area.
struct Shape {
  virtual ~Shape() = default;
  virtual double area() const = 0;
  double describe() const;
};

// Circle implements Shape.
class Circle : public Shape {
public:
  explicit Circle(double radius);
  double area() const;

private:
  double radius_;
};

}  // namespace sample

#endif  // SAMPLE_SHAPE_H
