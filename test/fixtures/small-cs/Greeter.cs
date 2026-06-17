namespace Sample;

/// <summary>Greets people by name.</summary>
public class Greeter
{
    private readonly string _name;

    public Greeter(string name)
    {
        _name = name;
    }

    /// <summary>Returns a greeting.</summary>
    public string Greet()
    {
        return Format();
    }

    private string Format()
    {
        return Normalize(_name);
    }

    private string Normalize(string s)
    {
        return s.Trim();
    }

    public string Summary => Describe();

    public string Describe()
    {
        return _name;
    }
}
