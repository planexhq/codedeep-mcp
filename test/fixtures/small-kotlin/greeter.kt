package fixtures

/** Greets people with a configurable prefix. */
class Greeter(private val prefix: String) {
    /** A human-readable summary of this greeter. */
    val summary: String
        get() = describe()

    init {
        setup()
    }

    fun greet(name: String): String {
        return format(name)
    }

    private fun format(s: String): String {
        return normalize(prefix + s)
    }

    fun describe(): String {
        return prefix
    }

    private fun setup() {}

    companion object {
        const val MAX = 100
        fun default(): Greeter = Greeter("hi")
    }
}

/** Trims surrounding whitespace. */
fun normalize(s: String): String {
    return s.trim()
}

const val MAX_LEN = 280
