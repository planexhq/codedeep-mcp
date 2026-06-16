import Foundation

/// Greets people with a configurable prefix.
public class Greeter {
    public let prefix: String
    private var count: Int

    /// The current greeting summary.
    public var summary: String {
        return describe()
    }

    /// Builds a greeter from a prefix.
    public init(prefix: String) {
        self.prefix = prefix
        self.count = 0
    }

    /// Greets the given name.
    public func greet(_ name: String) -> String {
        return format(name)
    }

    // formats the greeting; private helper.
    private func format(_ name: String) -> String {
        return normalize(name)
    }

    private func describe() -> String {
        return prefix
    }
}

/// Normalizes a name by trimming it.
public func normalize(_ name: String) -> String {
    return name
}

/// Maximum supported greeting length.
public let MAX_LEN = 64
