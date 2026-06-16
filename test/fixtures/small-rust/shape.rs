/// A drawable shape.
pub trait Shape {
    /// Returns the area of the shape.
    fn area(&self) -> f64;

    /// Human-readable name, with a default.
    fn name(&self) -> &str {
        "shape"
    }
}

/// A circle with a radius.
pub struct Circle {
    pub radius: f64,
}

impl Shape for Circle {
    fn area(&self) -> f64 {
        self.radius * self.radius * 3.14
    }
}

/// Kinds of shapes.
pub enum Kind {
    Round,
    Pointy(u32),
}

/// Builds the default unit circle.
pub fn default_circle() -> Circle {
    Circle { radius: 1.0 }
}
