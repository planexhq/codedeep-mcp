/// Greets people with a configurable prefix.
class Greeter {
  final String prefix;

  Greeter(this.prefix);

  Greeter.standard() : prefix = 'hi';

  /// A human-readable summary of this greeter.
  String get summary => describe();

  String greet(String name) => _format(name);

  String _format(String s) => normalize(prefix + s);

  String describe() => prefix;
}

/// Trims surrounding whitespace.
String normalize(String s) => s.trim();

const maxLen = 280;
