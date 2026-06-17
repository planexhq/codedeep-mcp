namespace Sample;

public class Program
{
    public static void Main()
    {
        var g = new Greeter("world");
        var msg = g.Greet();

        var shape = Shapes.DefaultCircle();
        var label = shape.Label();
    }
}
