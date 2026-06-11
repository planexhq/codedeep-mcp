/** Entry point wiring the demo together. */
public class App {
  public static void main(String[] args) {
    Greeter g = new Greeter("Hi");
    System.out.println(g.greet("probe"));
  }
}
