//! A small greeting library.

use std::fmt;

/// Greets people with a configurable prefix.
#[derive(Debug, Clone)]
pub struct Greeter {
    pub prefix: String,
    count: u32,
}

impl Greeter {
    /// Builds a greeter from a prefix.
    pub fn new(prefix: String) -> Self {
        Greeter { prefix, count: 0 }
    }

    /// Greets the given name.
    pub fn greet(&self, name: &str) -> String {
        self.format(name)
    }

    // formats the greeting; private helper.
    fn format(&self, name: &str) -> String {
        normalize(name)
    }
}

impl fmt::Display for Greeter {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}", self.prefix)
    }
}

/// Normalizes a name by trimming it.
pub fn normalize(name: &str) -> String {
    name.trim().to_string()
}

/// Maximum supported greeting length.
pub const MAX_LEN: usize = 64;

/// Utility helpers nested in a module.
pub mod util {
    /// Public helper that delegates to a private one.
    pub fn helper() -> i32 {
        inner_helper()
    }

    fn inner_helper() -> i32 {
        0
    }
}
