/// A 2-D shape.
abstract class Shape {
  double area();
}

/// Shared description behavior.
mixin Describable {
  String describe() => 'shape';
}

/// A circle with a radius.
class Circle extends Shape with Describable {
  final double radius;

  Circle(this.radius);

  @override
  double area() => radius * radius * 3;

  String describe() => 'circle';
}

/// The kinds of shape we render.
enum Kind { round, pointed }

/// Builds a label for a circle (extension method merged into Circle).
extension CircleLabel on Circle {
  String label() => describe();
}

Circle defaultCircle() => Circle(1.0);
