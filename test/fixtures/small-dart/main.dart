import 'greeter.dart';
import 'shape.dart';

void main() {
  final g = Greeter('hello');
  print(g.greet('world'));
  print(normalize('trim me'));

  final c = defaultCircle();
  print(c.label());

  final d = Circle(2.0)..area();
  print(d.area());
}
