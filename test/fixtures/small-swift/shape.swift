/// A drawable shape.
public protocol Shape {
    /// Returns the area of the shape.
    func area() -> Double
}

/// A circle with a radius.
public struct Circle: Shape {
    public let radius: Double

    public func area() -> Double {
        return radius * radius * 3.14
    }
}

/// Kinds of shapes.
public enum Kind {
    case round
    case pointy(Int)
}

/// Adds a label to circles.
extension Circle {
    /// A human-readable label.
    func label() -> String {
        return describe()
    }

    private func describe() -> String {
        return "circle"
    }
}

/// Builds the default unit circle.
public func defaultCircle() -> Circle {
    return Circle(radius: 1.0)
}
