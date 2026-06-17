namespace Sample;

public interface IShape
{
    double Area();
}

public class Circle : IShape
{
    private readonly double _r;

    public Circle(double r)
    {
        _r = r;
    }

    public double Area()
    {
        return 3.14 * _r * _r;
    }

    public string Describe()
    {
        return "circle";
    }
}

public static class Shapes
{
    public static Circle DefaultCircle()
    {
        return new Circle(1.0);
    }

    public static string Label(this Circle c)
    {
        return c.Describe();
    }
}
