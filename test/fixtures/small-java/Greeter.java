/** Greets people with a configurable prefix. */
public class Greeter {
  private final String prefix;

  public Greeter(String prefix) {
    this.prefix = prefix;
  }

  /** Returns the greeting for one person. */
  public String greet(String name) {
    return format(name);
  }

  private String format(String name) {
    return prefix + ", " + name + "!";
  }

  public static class Builder {
    private String prefix = "Hello";

    public Builder prefix(String value) {
      this.prefix = value;
      return this;
    }

    public Greeter build() {
      return new Greeter(prefix);
    }
  }
}
