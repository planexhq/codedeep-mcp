public interface Shape {
  double area();

  default String describe() {
    return "area=" + area();
  }
}

enum Color {
  RED("#f00"), GREEN("#0f0"), BLUE("#00f");

  private final String hex;

  Color(String hex) {
    this.hex = hex;
  }

  public String hex() {
    return hex;
  }
}

record Point(int x, int y) {
  Point {
    if (x < 0 || y < 0) throw new IllegalArgumentException("negative");
  }

  static Point origin() {
    return new Point(0, 0);
  }
}
