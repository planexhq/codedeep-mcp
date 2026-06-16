//! Application entry point.

/// Runs the program.
fn main() {
    let g = Greeter::new(String::from("Hi"));
    let msg = g.greet("world");
    let _ = normalize(&msg);
    let c = default_circle();
    let _ = c.area();
}
